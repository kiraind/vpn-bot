import 'dotenv/config'
import TelegramBot from 'node-telegram-bot-api'
import cron from 'node-cron'
import { ConfigWatcher, DEFAULT_CONFIG_PATH } from './config/load'
import { openDb } from './db'
import { AppContext, createEvents } from './context'
import { DEFAULT_BACKUP_PUB, DEFAULT_DB_PATH, DEFAULT_SSH_KEY_DIR } from './paths'
import { ensureCoordinatorKey } from './ssh/keys'
import { ensureSiteIdentities } from './services/identity'
import { createTelegramMemberChecker, handleChatMemberUpdate, sweepMembership } from './services/membership'
import { buildApi } from './api/server'
import { telegramMessenger } from './bot/messenger'
import { handleUserCallback, handleUserMessage, resendStaleBotConfigs } from './bot/userCommands'
import { handleAdminCallback, handleAdminCommand, sendDailyBackup } from './bot/adminCommands'
import { createBackup } from './ops/backup'
import { Reconciler } from './reconcile/loop'
import { probeNode, provisionNode } from './provision/node'
import { fetchCountryCidrs } from './geo/dbip'

// Resolved at runtime so it works from both src/ (tsx) and dist/ without pulling package.json into rootDir.
const coordinatorVersion: string = require('../package.json').version

// One process: Telegram bot + client API + reconciler + cron jobs (spec section 11).

async function main() {
  const watcher = new ConfigWatcher(DEFAULT_CONFIG_PATH)
  const initial = watcher.reload()

  if(!initial.ok) {
    console.error(`invalid config ${DEFAULT_CONFIG_PATH}:\n${initial.errors.join('\n')}`)
    process.exit(1)
  }

  const db = openDb(DEFAULT_DB_PATH)
  const key = ensureCoordinatorKey(DEFAULT_SSH_KEY_DIR)
  const config = () => watcher.config!

  // The bot token is read once; changing it needs a restart.
  const bot = new TelegramBot(config().telegram.botToken, {
    // getUpdates is sent form-encoded, so the list must be a JSON string or Telegram ignores it (and chat_member is off by default).
    polling: { params: { allowed_updates: JSON.stringify(['message', 'callback_query', 'chat_member']) as unknown as string[] } },
  })
  const messenger = telegramMessenger(bot)

  const ctx: AppContext = {
    db,
    config,
    events: createEvents(),
    async alert(text, opts) {
      const targets = opts?.announce ? [config().telegram.chatId] : config().telegram.admins

      for(const chatId of targets) {
        try {
          await messenger.sendMessage(chatId, text)
        } catch(e) {
          console.error(`alert to ${chatId} failed:`, e)
        }
      }
    },
  }

  ensureSiteIdentities(db, config())

  const checker = createTelegramMemberChecker(
    (chatId, userId) => bot.getChatMember(chatId, userId),
    config().telegram.chatId
  )

  const reconciler = new Reconciler(ctx, {
    provision: provisionNode,
    probe: probeNode,
    provisionDeps: { db, key, coordinatorVersion, log: msg => console.log(msg) },
    reloadConfig: () => watcher.reload(),
    fetchGeo: country => fetchCountryCidrs(country),
    coordinatorVersion,
  })

  const backup = () => createBackup({
    db,
    configPath: DEFAULT_CONFIG_PATH,
    sshKeyDir: DEFAULT_SSH_KEY_DIR,
    backupPubPath: DEFAULT_BACKUP_PUB,
  })
  const adminDeps = { messenger, control: reconciler, backup }
  const userDeps = { messenger, checker }

  bot.on('message', async msg => {
    try {
      if(!msg.text) return
      if(await handleAdminCommand(ctx, adminDeps, msg)) return
      await handleUserMessage(ctx, userDeps, msg)
    } catch(e) {
      console.error('message handler failed:', e)
    }
  })

  bot.on('callback_query', async query => {
    try {
      if(await handleAdminCallback(ctx, adminDeps, query)) return
      await handleUserCallback(ctx, userDeps, query)
    } catch(e) {
      console.error('callback handler failed:', e)
    }
  })

  // R-B2: instant suspension when the bot is an admin of the users' chat.
  bot.on('chat_member', update => {
    try {
      if(update.chat.id === config().telegram.chatId) {
        handleChatMemberUpdate(ctx, update)
      }
    } catch(e) {
      console.error('chat_member handler failed:', e)
    }
  })

  bot.on('polling_error', e => console.error('telegram polling error:', e.message))

  // R-O5: once LOCAL runs the new state (rotated params, new client address, reactivated user),
  // owners of bot-issued configs whose revision moved get a new .conf.
  ctx.events.on('local-applied', () => {
    resendStaleBotConfigs(ctx, messenger).catch(e => console.error('resend failed:', e))
  })

  watcher.on('invalid', errors => console.error(`config reload failed:\n${errors.join('\n')}`))
  watcher.on('change', () => reconciler.applyNow().catch(e => console.error('apply failed:', e)))
  watcher.start()

  const api = buildApi(ctx, { checker })
  const [host, port] = config().api.listen.split(':')
  await api.listen({ host, port: Number(port) })
  console.log(`API listening on ${config().api.listen}`)

  reconciler.start()

  // R-B1: hourly membership sweep, as in v1.
  cron.schedule('0 0 * * * *', () => {
    sweepMembership(ctx, checker)
      .then(result => console.log('membership sweep:', result))
      .catch(e => console.error('membership sweep failed:', e))
  })

  // R-S5: daily encrypted backup to the admins.
  cron.schedule('0 0 3 * * *', () => {
    sendDailyBackup(ctx, { messenger, backup }).catch(e => console.error('daily backup failed:', e))
  })

  // A LOCAL replacement changes Endpoint; resend to bot-only owners on startup too in case
  // the process restarted between the change and the resend.
  resendStaleBotConfigs(ctx, messenger).catch(e => console.error('resend failed:', e))

  const shutdown = async () => {
    reconciler.stop()
    watcher.stop()
    await bot.stopPolling()
    await api.close()
    db.close()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
