import fs from 'fs'
import path from 'path'
import type TelegramBot from 'node-telegram-bot-api'
import type { AppContext } from '../context'
import type { ReconcileReport, ReconcilerControl } from '../reconcile/control'
import { appVersionStats } from '../services/auth'
import { findUserByUsername, getUser, revokeUser, unrevokeUser } from '../services/users'
import { getKnownHost } from '../ssh/knownHosts'
import { nodeName, type HostRow } from '../types'
import type { Messenger } from './messenger'

// Admin bot commands (spec 10, runbook 5). Replies are plain text on purpose: they carry error
// messages, addresses and versions that would constantly break MarkdownV2 escaping.

export interface AdminCommandDeps {
  messenger: Messenger
  control: ReconcilerControl
  backup: () => Promise<{ file: string, name: string }>
}

const ROTATE_PREFIX = 'rotate_confirm:'
const ERROR_MAX = 200

const HELP = [
  'Команды админа:',
  '/status — состояние площадок и узлов, последние ошибки, версии приложений',
  '/apply — перечитать config.yaml и применить сейчас',
  '/apply upgrade — то же + обновить пакеты на серверах',
  '/trust <узел> — принять новый host key после переустановки (например /trust main/local)',
  '/rotate tunnel | /rotate clients — новые параметры обфускации',
  '/revoke_user <@username|id> — отозвать пользователя (насовсем, даже если он остался в чате)',
  '/unrevoke_user <@username|id> — вернуть доступ; конфиги заново выпускает сам пользователь',
  '/backup — прислать бэкап сейчас',
].join('\n')

const ROTATE_TEXT: Record<'tunnel' | 'clients', string> = {
  tunnel: 'Перегенерировать параметры обфускации туннеля LOCAL↔REMOTE?\n\n'
    + 'Новые параметры применятся на обоих серверах сразу. Клиенты ничего не заметят, '
    + 'будет короткий разрыв зарубежного трафика.',
  clients: 'Перегенерировать параметры обфускации клиентского интерфейса LOCAL?\n\n'
    + 'Изменятся все клиентские конфиги. Приложения заберут новые сами; владельцам .conf, '
    + 'выданных ботом, бот пришлёт новый конфиг. Пока устройство не обновилось, оно не подключится.',
}

export function isAdmin(ctx: AppContext, tgId: number): boolean {
  return ctx.config().telegram.admins.includes(tgId)
}

/** '/cmd@bot a b' → ['cmd', ['a', 'b']]; null for non-commands. */
function parseCommand(text: string): [string, string[]] | null {
  const parts = text.trim().split(/\s+/)
  const match = /^\/([a-z_]+)(@\S+)?$/i.exec(parts[0] ?? '')
  return match ? [match[1].toLowerCase(), parts.slice(1)] : null
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const OUTCOME_LABEL: Record<ReconcileReport['outcome'], string> = {
  'applied': 'применено',
  'up-to-date': 'без изменений',
  'skipped': 'пропущено',
  'error': 'ОШИБКА',
}

export function formatReports(reports: ReconcileReport[]): string {
  if(reports.length === 0) return 'Узлов для применения нет'
  return reports
    .map(r => `${r.node}: ${OUTCOME_LABEL[r.outcome] ?? r.outcome}${r.message ? ` — ${truncate(r.message, ERROR_MAX)}` : ''}`)
    .join('\n')
}

function configuredNodes(ctx: AppContext): string[] {
  return ctx.config().sites.flatMap(site => [nodeName(site.name, 'local'), nodeName(site.name, 'remote')])
}

export function formatStatus(ctx: AppContext, at = new Date()): string {
  const db = ctx.db
  const lines: string[] = []
  const sites = db.prepare('SELECT name, network, checked_at FROM sites').all() as { name: string, network: string, checked_at: string | null }[]
  const siteByName = new Map(sites.map(s => [s.name, s]))
  const hosts = db.prepare('SELECT * FROM hosts').all() as HostRow[]
  const hostByNode = new Map(hosts.map(h => [h.node, h]))

  for(const site of ctx.config().sites) {
    const row = siteByName.get(site.name)
    lines.push(`Площадка ${site.name}: ${row?.network ?? 'нет данных'}${row?.checked_at ? ` (проверено ${row.checked_at})` : ''}`)

    for(const node of [nodeName(site.name, 'local'), nodeName(site.name, 'remote')]) {
      const host = hostByNode.get(node)
      if(!host) {
        lines.push(`  ${node}: ещё не настраивался`)
        continue
      }
      lines.push(`  ${node} (${host.address}): фаза ${host.phase}, здоровье ${host.health}`)
      lines.push(`    применено: ${host.applied_hash ? host.applied_hash.slice(0, 8) : '—'}, последний успех: ${host.last_ok_at ?? '—'}`)
      // An error older than the last success is history (e.g. a host key mismatch before /trust).
      const errorIsStale = !!host.last_error_at && !!host.last_ok_at && host.last_error_at < host.last_ok_at
      if(host.last_error && !errorIsStale) {
        lines.push(`    ошибка${host.last_error_at ? ` (${host.last_error_at})` : ''}: ${truncate(host.last_error, ERROR_MAX)}`)
      }
      if(host.consecutive_failures > 0) {
        lines.push(`    неудач подряд: ${host.consecutive_failures}${host.next_attempt_at ? `, следующая попытка ${host.next_attempt_at}` : ''}`)
      }
      if(getKnownHost(db, host.address)?.mismatch_key) {
        lines.push(`    host key изменился! Если сервер переустанавливал ты — /trust ${node}`)
      }
    }
  }

  // Hosts left over from sites that were removed from config.yaml
  const known = new Set(configuredNodes(ctx))
  for(const host of hosts.filter(h => !known.has(h.node))) {
    lines.push(`Узел ${host.node} (${host.address}) нет в config.yaml: фаза ${host.phase}, здоровье ${host.health}`)
  }

  const users = db.prepare('SELECT status, COUNT(*) AS count FROM users GROUP BY status').all() as { status: string, count: number }[]
  const userCount = (status: string) => users.find(u => u.status === status)?.count ?? 0
  const activeConfigs = (db.prepare(`SELECT COUNT(*) AS count FROM client_configs WHERE state = 'active'`).get() as { count: number }).count

  lines.push('')
  lines.push(`Пользователи: активных ${userCount('active')}, приостановлено ${userCount('suspended')}`)
  lines.push(`Активных конфигов: ${activeConfigs}`)

  const versions = appVersionStats(db, at)
  lines.push(versions.length > 0
    ? `Версии приложения (30 дней): ${versions.map(v => `${v.version} — ${v.count}`).join(', ')}`
    : 'Версии приложения (30 дней): нет данных')

  return lines.join('\n')
}

// createBackup puts the file in its own fresh temp dir; drop that too (rmdir only succeeds when empty)
function removeBackup(file: string) {
  fs.rmSync(file, { force: true })
  try {
    fs.rmdirSync(path.dirname(file))
  } catch {}
}

async function runAndReport(messenger: Messenger, chatId: number, action: () => Promise<ReconcileReport[]>) {
  try {
    await messenger.sendMessage(chatId, formatReports(await action()))
  } catch(err) {
    await messenger.sendMessage(chatId, `Не получилось: ${truncate(errorText(err), ERROR_MAX * 2)}`)
  }
}

async function revokeUserCommand(ctx: AppContext, messenger: Messenger, chatId: number, arg: string | undefined) {
  if(!arg) {
    await messenger.sendMessage(chatId, 'Использование: /revoke_user <@username|id>')
    return
  }
  const user = /^\d+$/.test(arg) ? getUser(ctx.db, Number(arg)) : findUserByUsername(ctx.db, arg)
  if(!user) {
    await messenger.sendMessage(chatId, `Пользователь ${arg} не найден`)
    return
  }
  const { configs, tokens } = revokeUser(ctx, user.tg_id)
  const who = user.username ? `@${user.username} (${user.tg_id})` : String(user.tg_id)
  await messenger.sendMessage(chatId, `${who} отозван: конфигов ${configs}, токенов устройств ${tokens}`)
}

async function unrevokeUserCommand(ctx: AppContext, messenger: Messenger, chatId: number, arg: string | undefined) {
  if(!arg) {
    await messenger.sendMessage(chatId, 'Использование: /unrevoke_user <@username|id>')
    return
  }
  const user = /^\d+$/.test(arg) ? getUser(ctx.db, Number(arg)) : findUserByUsername(ctx.db, arg)
  if(!user) {
    await messenger.sendMessage(chatId, `Пользователь ${arg} не найден`)
    return
  }
  const who = user.username ? `@${user.username} (${user.tg_id})` : String(user.tg_id)
  await messenger.sendMessage(chatId, unrevokeUser(ctx, user.tg_id)
    ? `${who}: доступ возвращён, при следующем обращении к боту (если он в чате) снова сможет выпускать конфиги`
    : `${who} не был отозван`)
}

async function backupCommand(deps: AdminCommandDeps, chatId: number) {
  let file: string | undefined
  try {
    const result = await deps.backup()
    file = result.file
    await deps.messenger.sendDocument(chatId, fs.readFileSync(file), result.name)
  } catch(err) {
    await deps.messenger.sendMessage(chatId, `Бэкап не удался: ${truncate(errorText(err), ERROR_MAX * 2)}`)
  } finally {
    if(file) removeBackup(file)
  }
}

/** True when the message was an admin command from an admin (handled here); false lets the user handler run. */
export async function handleAdminCommand(ctx: AppContext, deps: AdminCommandDeps, msg: TelegramBot.Message): Promise<boolean> {
  if(!msg.from || !msg.text || msg.chat.id !== msg.from.id || !isAdmin(ctx, msg.from.id)) return false
  const parsed = parseCommand(msg.text)
  if(!parsed) return false

  const [command, args] = parsed
  const chatId = msg.chat.id
  const { messenger, control } = deps

  switch(command) {
    case 'help':
      await messenger.sendMessage(chatId, HELP)
      return true

    case 'status':
      await messenger.sendMessage(chatId, formatStatus(ctx))
      return true

    case 'apply': {
      if(args.length > 0 && args[0] !== 'upgrade') {
        await messenger.sendMessage(chatId, 'Использование: /apply или /apply upgrade')
        return true
      }
      const upgrade = args[0] === 'upgrade'
      await messenger.sendMessage(chatId, upgrade ? 'Применяю с обновлением пакетов…' : 'Применяю…')
      await runAndReport(messenger, chatId, () => control.applyNow({ upgrade }))
      return true
    }

    case 'trust': {
      const node = args[0]
      const nodes = configuredNodes(ctx)
      if(!node || !nodes.includes(node)) {
        await messenger.sendMessage(chatId, `Использование: /trust <узел>, узлы: ${nodes.join(', ')}`)
        return true
      }
      await messenger.sendMessage(chatId, `Принимаю новый host key для ${node} и применяю…`)
      await runAndReport(messenger, chatId, () => control.trust(node))
      return true
    }

    case 'rotate': {
      const which = args[0]
      if(which !== 'tunnel' && which !== 'clients') {
        await messenger.sendMessage(chatId, 'Использование: /rotate tunnel или /rotate clients')
        return true
      }
      await messenger.sendMessage(chatId, ROTATE_TEXT[which], {
        reply_markup: {
          inline_keyboard: [[{ text: 'Да, перегенерировать', callback_data: `${ROTATE_PREFIX}${which}` }]],
        },
      })
      return true
    }

    case 'revoke_user':
      await revokeUserCommand(ctx, messenger, chatId, args[0])
      return true

    case 'unrevoke_user':
      await unrevokeUserCommand(ctx, messenger, chatId, args[0])
      return true

    case 'backup':
      await backupCommand(deps, chatId)
      return true

    default:
      return false
  }
}

/** Handles the /rotate confirmation button; false for callbacks that aren't ours. */
export async function handleAdminCallback(ctx: AppContext, deps: AdminCommandDeps, query: TelegramBot.CallbackQuery): Promise<boolean> {
  const data = query.data ?? ''
  if(!data.startsWith(ROTATE_PREFIX)) return false

  const { messenger } = deps
  const which = data.slice(ROTATE_PREFIX.length)
  if(!isAdmin(ctx, query.from.id) || (which !== 'tunnel' && which !== 'clients')) {
    await messenger.answerCallbackQuery(query.id, 'Недоступно')
    return true
  }

  await messenger.answerCallbackQuery(query.id, 'Перегенерирую…')
  const chatId = query.message?.chat.id ?? query.from.id
  // Drop the button so a second tap can't rotate twice
  if(query.message) {
    await messenger.editMessageText(chatId, query.message.message_id, `${ROTATE_TEXT[which]}\n\nПодтверждено, перегенерирую…`)
      .catch(() => {})
  }
  await runAndReport(messenger, chatId, () => deps.control.rotate(which))
  return true
}

/** Daily cron (R-S5): one encrypted backup, sent to every admin. */
export async function sendDailyBackup(ctx: AppContext, deps: Pick<AdminCommandDeps, 'messenger' | 'backup'>, date = new Date()): Promise<void> {
  let file: string | undefined
  try {
    const result = await deps.backup()
    file = result.file
    const buf = fs.readFileSync(file)
    const caption = `Ежедневный бэкап ${date.toISOString().slice(0, 10)}`
    for(const admin of ctx.config().telegram.admins) {
      try {
        await deps.messenger.sendDocument(admin, buf, result.name, caption)
      } catch(err) {
        await ctx.alert(`Не удалось отправить бэкап админу ${admin}: ${errorText(err)}`)
      }
    }
  } catch(err) {
    await ctx.alert(`Ежедневный бэкап не удался: ${errorText(err)}`)
  } finally {
    if(file) removeBackup(file)
  }
}
