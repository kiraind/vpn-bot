import type TelegramBot from 'node-telegram-bot-api'
import QRCode from 'qrcode'
import type { AppContext } from '../context'
import { now } from '../db'
import type { ClientConfigRow, ConfigState, DeviceTokenRow } from '../types'
import { configView, createConfig, findConfigByName, listConfigs, markDelivered, revokeConfig, staleBotConfigs } from '../services/configs'
import { issueLoginCode, listTokens, revokeTokenForUser } from '../services/auth'
import type { MemberChecker } from '../services/membership'
import { getUser, markMembershipChecked, reactivateUser, suspendUser, upsertUser } from '../services/users'
import type { Messenger } from './messenger'

// User-facing bot commands (spec section 10). Identity is the Telegram id (R-S1).

export interface UserCommandDeps {
  messenger: Messenger
  checker: MemberChecker
}

export const AUTO_DELETE_MS = 5 * 60 * 1000
const REVOKE_PREFIX = 'revoke_token:'

const NOT_MEMBER = 'Сорри, тебя нет в списках'
const CHECK_FAILED = 'Не получилось проверить, есть ли ты в чате. Попробуй чуть позже'
const REVOKED = 'Доступ отозван администратором.'
const SEND_FAILED = 'Не получилось отправить конфиг, попробуй ещё раз.'
// Telegram refuses to delete messages older than 48 hours; past this there is no point trying
const DELETE_GIVE_UP_MS = 47 * 60 * 60 * 1000

const MD_SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]/g

/** MarkdownV2 escaping for plain text. */
export function escapeMd(text: string): string {
  return text.replace(MD_SPECIAL, '\\$&')
}

/** MarkdownV2 escaping inside `code` spans: only ` and \ are special there. */
function escapeCode(text: string): string {
  return text.replace(/[`\\]/g, '\\$&')
}

type Access = 'ok' | 'not-member' | 'unknown' | 'revoked'

/**
 * Live check; when Telegram can't answer we trust a cached active user, but never a
 * suspended or unknown one. A confirmed non-member is suspended right away (R-B1).
 */
async function checkAccess(ctx: AppContext, checker: MemberChecker, from: TelegramBot.User): Promise<Access> {
  const user = getUser(ctx.db, from.id)
  // Admin revocation outranks chat membership: rejoining must not undo /revoke_user
  if(user?.revoked_at) return 'revoked'
  const { status, reason } = await checker(from.id)

  if(status === 'unknown') {
    if(user?.status !== 'active') return 'unknown'
    upsertUser(ctx.db, from.id, from.username ?? null)
    return 'ok'
  }

  if(status === 'not-member') {
    if(user) {
      markMembershipChecked(ctx.db, from.id, now())
      if(user.status === 'active') {
        const { configs, tokens } = suspendUser(ctx, from.id)
        console.log(`${now()} suspended ${from.id} on bot contact: ${configs} config(s), ${tokens} token(s), reason: ${reason}`)
      }
    }
    return 'not-member'
  }

  upsertUser(ctx.db, from.id, from.username ?? null)
  markMembershipChecked(ctx.db, from.id, now())
  if(user?.status === 'suspended') {
    const configs = reactivateUser(ctx, from.id)
    console.log(`${now()} reactivated ${from.id} (@${from.username ?? '-'}): ${configs} config(s)`)
  }
  return 'ok'
}

function denyText(access: Access): string {
  if(access === 'unknown') return CHECK_FAILED
  if(access === 'revoked') return REVOKED
  return NOT_MEMBER
}

/** `/add@MyBot phone` → ['/add', 'phone'] */
function parseCommand(text: string): [string, string | undefined] {
  const [head, arg] = text.trim().split(/\s+/)
  return [head.replace(/@\S*$/, '').toLowerCase(), arg]
}

export async function handleUserMessage(ctx: AppContext, deps: UserCommandDeps, msg: TelegramBot.Message): Promise<void> {
  const from = msg.from
  if(!from || msg.chat.id !== from.id) return

  const { messenger } = deps
  const chatId = from.id

  const access = await checkAccess(ctx, deps.checker, from)
  if(access !== 'ok') {
    await messenger.sendMessage(chatId, denyText(access))
    return
  }

  const text = msg.text
  if(!text) return

  const [command, arg] = parseCommand(text)

  switch(command) {
    case '/start':
    case '/info':
      await messenger.sendMessage(chatId, infoText(ctx, chatId), { parse_mode: 'MarkdownV2' })
      return
    case '/add':
      await addDevice(ctx, messenger, chatId, arg)
      return
    case '/remove':
      await removeDevice(ctx, messenger, chatId, arg)
      return
    case '/login':
      await sendLoginCode(ctx, messenger, chatId)
      return
    case '/devices': {
      const view = devicesView(ctx, chatId)
      await messenger.sendMessage(chatId, view.text, { reply_markup: view.keyboard })
      return
    }
    default:
      await messenger.sendMessage(chatId, 'Не понимаю, попробуй /start')
  }
}

const STATE_LABELS: Record<ConfigState, string> = {
  active: 'работает',
  suspended: 'приостановлено',
  revoked: 'удалено',
}

function infoText(ctx: AppContext, tgId: number): string {
  const configs = listConfigs(ctx.db, tgId)
  const list = configs.map(row => `📲 \`${escapeCode(row.name)}\` — ${escapeMd(STATE_LABELS[row.state])}`).join('\n')

  return (configs.length > 0 ? `Твои устройства:\n\n${list}\n` : 'У тебя сейчас нет активных устройств\n') +
    '\n' +
    'Доступные команды:\n' +
    '\n' +
    `\`/start\` или \`/info\` ${escapeMd('— увидеть это сообщение')}\n` +
    `\`/add <name>\` ${escapeMd('— добавить новое устройство')}\n` +
    `\`/remove <name>\` ${escapeMd('— удалить устройство')}\n` +
    `\`/login\` ${escapeMd('— код для входа в приложение')}\n` +
    `\`/devices\` ${escapeMd('— где выполнен вход в приложение')}\n`
}

async function addDevice(ctx: AppContext, messenger: Messenger, chatId: number, arg: string | undefined) {
  const name = arg?.toLowerCase()
  const result = name ? createConfig(ctx, { tgId: chatId, name, issuedVia: 'bot' }) : { error: 'invalid_name' as const }

  if('error' in result) {
    const user = getUser(ctx.db, chatId)
    await messenger.sendMessage(chatId, result.error === 'name_taken'
      ? 'Устройство с таким именем уже есть'
      : result.error === 'not_member'
        ? (user?.revoked_at ? REVOKED : NOT_MEMBER)
        : 'Укажи имя устройства: латинские буквы, цифры и черточки (-), до 32 символов ([a-z0-9-]{1,32}). Например: /add phone')
    return
  }

  try {
    await sendConfigToUser(ctx, messenger, result, 'Готово! Сервер подхватит новое устройство в течение нескольких секунд.')
  } catch(e) {
    // The user never got the keys; keeping the row would block the name and hold a dead peer
    console.warn(`${now()} failed to send new config ${result.id} to ${chatId}: ${e instanceof Error ? e.message : String(e)}`)
    revokeConfig(ctx, chatId, result.id)
    await messenger.sendMessage(chatId, SEND_FAILED).catch(() => {})
  }
}

/**
 * Sends a config as QR + .conf, auto-deleted after 5 minutes along with the warning; the intro
 * stays. Records the delivered revision so R-O5 knows when to resend.
 */
export async function sendConfigToUser(ctx: AppContext, messenger: Messenger, row: ClientConfigRow, intro: string): Promise<void> {
  const chatId = row.tg_id
  const view = configView(ctx, row)
  const qr = await QRCode.toBuffer(view.awg, { type: 'png' })

  await messenger.sendMessage(chatId, intro)

  const sent: number[] = []
  // Recorded in the DB as each one goes out, so a restart doesn't leave keys in the chat
  const track = (id: number) => {
    sent.push(id)
    scheduleDeletion(ctx, chatId, id, new Date(Date.now() + AUTO_DELETE_MS))
  }
  try {
    track(await messenger.sendPhoto(chatId, qr, { caption: 'Отсканируй этот код в приложении Amnezia VPN —' }))
    track(await messenger.sendDocument(chatId, Buffer.from(view.awg, 'utf8'), `${row.name}-amnezia.conf`,
      '— или выбери в нем этот файл конфигурации.'))
    track(await messenger.sendMessage(chatId,
      'Эти сообщения удалятся через 5 минут. Не делись ими ни с кем и не используй одинаковые конфиги для разных устройств.'))
  } finally {
    // Whatever made it out still has to disappear, even if a later send failed. The timer is
    // for punctuality; the periodic drain covers restarts.
    setTimeout(() => {
      for(const id of sent) {
        if(claimDeletion(ctx, chatId, id)) {
          messenger.deleteMessage(chatId, id).catch(() => {})
        }
      }
    }, AUTO_DELETE_MS)
  }

  markDelivered(ctx.db, row.id, view.revision, 'bot')
}

function scheduleDeletion(ctx: AppContext, chatId: number, messageId: number, at: Date) {
  ctx.db.prepare('INSERT OR REPLACE INTO pending_deletions (chat_id, message_id, delete_at) VALUES (?, ?, ?)')
    .run(chatId, messageId, at.toISOString())
}

/** Removes the row; true if this caller owns the deletion (so timer and drain never both try). */
function claimDeletion(ctx: AppContext, chatId: number, messageId: number): boolean {
  return ctx.db.prepare('DELETE FROM pending_deletions WHERE chat_id = ? AND message_id = ?').run(chatId, messageId).changes > 0
}

/**
 * Deletes due auto-delete messages (run on startup and every minute). Rows are removed whatever
 * Telegram says; ones too old for Telegram to delete are dropped without trying. Returns attempts made.
 */
export async function drainPendingDeletions(ctx: AppContext, messenger: Messenger, now: Date = new Date()): Promise<number> {
  const giveUp = new Date(now.getTime() - DELETE_GIVE_UP_MS).toISOString()
  ctx.db.prepare('DELETE FROM pending_deletions WHERE delete_at < ?').run(giveUp)

  const due = ctx.db.prepare('SELECT chat_id, message_id FROM pending_deletions WHERE delete_at <= ? ORDER BY delete_at')
    .all(now.toISOString()) as { chat_id: number, message_id: number }[]
  let attempted = 0
  for(const row of due) {
    if(!claimDeletion(ctx, row.chat_id, row.message_id)) continue
    attempted += 1
    try {
      await messenger.deleteMessage(row.chat_id, row.message_id)
    } catch {
      // Already deleted by the user, chat gone, bot blocked: nothing more to do
    }
  }
  return attempted
}

/** R-O5: resends bot-issued configs whose server-side parameters changed. Returns how many were sent. */
// Runs never overlap: overlapping triggers (several sites, startup + first apply) would otherwise
// send the same .conf twice, since rows are marked delivered only after sending.
let resendRunning: Promise<number> | null = null
let resendAgain = false

export function resendStaleBotConfigs(ctx: AppContext, messenger: Messenger): Promise<number> {
  if(resendRunning) {
    resendAgain = true
    return resendRunning
  }
  resendRunning = (async () => {
    let total = 0
    do {
      resendAgain = false
      total += await resendOnce(ctx, messenger)
    } while(resendAgain)
    return total
  })().finally(() => {
    resendRunning = null
  })
  return resendRunning
}

async function resendOnce(ctx: AppContext, messenger: Messenger): Promise<number> {
  let sent = 0
  for(const row of staleBotConfigs(ctx)) {
    try {
      await sendConfigToUser(ctx, messenger, row,
        `Конфигурация сервера изменилась, вот обновлённый конфиг для ${row.name}. Старый больше не работает.`)
      sent += 1
    } catch(e) {
      // E.g. the user blocked the bot; the row stays stale and is retried next time
      console.warn(`${now()} failed to resend config ${row.id} to ${row.tg_id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return sent
}

async function removeDevice(ctx: AppContext, messenger: Messenger, chatId: number, arg: string | undefined) {
  const row = arg ? findConfigByName(ctx.db, chatId, arg.toLowerCase()) : null
  if(!row || !revokeConfig(ctx, chatId, row.id)) {
    await messenger.sendMessage(chatId, 'Устройства с таким именем нет :(')
    return
  }
  await messenger.sendMessage(chatId, 'Готово!')
}

async function sendLoginCode(ctx: AppContext, messenger: Messenger, chatId: number) {
  const { code } = issueLoginCode(ctx.db, chatId)
  await messenger.sendMessage(chatId,
    `Код для входа в приложение: \`${escapeCode(code)}\`\n\n` +
    escapeMd('Введи его в приложении. Код одноразовый и действует 5 минут.'),
    { parse_mode: 'MarkdownV2' })
}

function formatSeen(iso: string | null): string {
  if(!iso) return 'никогда'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function tokenLabel(token: DeviceTokenRow): string {
  const label = token.label?.trim() || 'без названия'
  return label.length > 40 ? `${label.slice(0, 39)}…` : label
}

function devicesView(ctx: AppContext, tgId: number): { text: string, keyboard: TelegramBot.InlineKeyboardMarkup } {
  const tokens = listTokens(ctx.db, tgId)
  if(tokens.length === 0) {
    return { text: 'Ты пока не входил в приложение ни на одном устройстве. Код для входа — /login', keyboard: { inline_keyboard: [] } }
  }

  // Plain text, not MarkdownV2: labels come from the app and may contain anything
  const lines = tokens.map(token => `📱 ${tokenLabel(token)} — последний визит: ${formatSeen(token.last_seen_at)}`)
  return {
    text: `Устройства, где выполнен вход в приложение:\n\n${lines.join('\n')}\n\nНажми кнопку, чтобы выйти на устройстве.`,
    keyboard: {
      inline_keyboard: tokens.map(token => [{
        text: `Выйти: ${tokenLabel(token)}`,
        callback_data: `${REVOKE_PREFIX}${token.token_hash.slice(0, 8)}`,
      }]),
    },
  }
}

export async function handleUserCallback(ctx: AppContext, deps: UserCommandDeps, query: TelegramBot.CallbackQuery): Promise<void> {
  const { messenger } = deps
  const from = query.from
  const message = query.message
  const data = query.data ?? ''

  if(!message || message.chat.id !== from.id || !data.startsWith(REVOKE_PREFIX)) {
    await messenger.answerCallbackQuery(query.id)
    return
  }

  const access = await checkAccess(ctx, deps.checker, from)
  if(access !== 'ok') {
    await messenger.answerCallbackQuery(query.id, denyText(access))
    return
  }

  const revoked = revokeTokenForUser(ctx.db, from.id, data.slice(REVOKE_PREFIX.length))
  await messenger.answerCallbackQuery(query.id, revoked ? 'Готово, вход на устройстве отозван' : 'Это устройство уже отозвано')

  const view = devicesView(ctx, from.id)
  try {
    await messenger.editMessageText(from.id, message.message_id, view.text, { reply_markup: view.keyboard })
  } catch(e) {
    // "message is not modified" on a double tap is harmless
    console.warn(`${now()} /devices edit failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}
