import fs from 'fs'
import os from 'os'
import path from 'path'
import type TelegramBot from 'node-telegram-bot-api'
import { describe, expect, it, vi } from 'vitest'
import { createEvents, type AppContext } from '../context'
import { now, openDb } from '../db'
import type { ReconcilerControl, ReconcileReport } from '../reconcile/control'
import { exampleConfig } from '../services/testFixtures'
import { getUser, upsertUser } from '../services/users'
import { handleAdminCallback, handleAdminCommand, isAdmin, sendDailyBackup } from './adminCommands'
import type { Messenger } from './messenger'

const ADMIN = 123456789
const USER = 42

function fakeCtx() {
  const ctx: AppContext = {
    db: openDb(':memory:'),
    config: () => exampleConfig(),
    events: createEvents(),
    alert: vi.fn(async () => {}),
  }
  return ctx
}

function fakeMessenger() {
  const sent: { chatId: number | string, text: string, opts?: unknown }[] = []
  const docs: { chatId: number | string, buf: Buffer, filename: string, caption?: string }[] = []
  const messenger: Messenger = {
    sendMessage: vi.fn(async (chatId, text, opts) => { sent.push({ chatId, text, opts }); return sent.length }),
    sendPhoto: vi.fn(async () => 1),
    sendDocument: vi.fn(async (chatId, buf, filename, caption) => { docs.push({ chatId, buf, filename, caption }); return 1 }),
    deleteMessage: vi.fn(async () => {}),
    answerCallbackQuery: vi.fn(async () => {}),
    editMessageText: vi.fn(async () => {}),
  }
  return { messenger, sent, docs }
}

const reports: ReconcileReport[] = [
  { node: 'main/local', outcome: 'applied' },
  { node: 'main/remote', outcome: 'error', message: 'ssh timeout' },
]

function fakeControl(): ReconcilerControl {
  return {
    applyNow: vi.fn(async () => reports),
    trust: vi.fn(async () => reports),
    rotate: vi.fn(async () => reports),
  }
}

function tmpBackup(): () => Promise<{ file: string, name: string }> {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-test-'))
    const file = path.join(dir, 'vpn-backup-x.tar.age')
    fs.writeFileSync(file, 'encrypted')
    return { file, name: 'vpn-backup-x.tar.age' }
  }
}

function setup() {
  const ctx = fakeCtx()
  const { messenger, sent, docs } = fakeMessenger()
  const control = fakeControl()
  const deps = { messenger, control, backup: vi.fn(tmpBackup()) }
  return { ctx, deps, sent, docs, control }
}

function msg(text: string, from = ADMIN, chat = from): TelegramBot.Message {
  return { message_id: 1, date: 0, chat: { id: chat, type: 'private' }, from: { id: from, is_bot: false, first_name: 'x' }, text }
}

describe('admin commands', () => {
  it('recognises admins from config', () => {
    const { ctx } = setup()
    expect(isAdmin(ctx, ADMIN)).toBe(true)
    expect(isAdmin(ctx, USER)).toBe(false)
  })

  it('ignores non-admins, group chats and user commands', async () => {
    const { ctx, deps, sent } = setup()
    expect(await handleAdminCommand(ctx, deps, msg('/status', USER))).toBe(false)
    expect(await handleAdminCommand(ctx, deps, msg('/status', ADMIN, -100))).toBe(false)
    expect(await handleAdminCommand(ctx, deps, msg('/add phone'))).toBe(false)
    expect(await handleAdminCommand(ctx, deps, msg('hello'))).toBe(false)
    expect(sent).toHaveLength(0)
  })

  it('/help lists admin commands', async () => {
    const { ctx, deps, sent } = setup()
    expect(await handleAdminCommand(ctx, deps, msg('/help@vpnbot'))).toBe(true)
    expect(sent[0].text).toContain('/rotate tunnel')
  })

  it('/status shows sites, nodes, mismatch hint, users and versions', async () => {
    const { ctx, deps, sent } = setup()
    const db = ctx.db
    db.prepare(`INSERT INTO sites (name, network, checked_at) VALUES ('main', 'degraded', '2026-10-12T10:00:00Z')`).run()
    db.prepare(`INSERT INTO nodes (name, role, identity, created_at) VALUES ('main/local', 'local', '{}', ?)`).run(now())
    db.prepare(`
      INSERT INTO hosts (node, address, applied_hash, phase, last_error, consecutive_failures, next_attempt_at, health)
      VALUES ('main/local', '203.0.113.10', 'abcdef0123456789', 'ready', ?, 3, '2026-10-12T11:00:00Z', 'ok')
    `).run('x'.repeat(500))
    db.prepare(`INSERT INTO known_hosts (address, host_key, first_seen_at, mismatch_key) VALUES ('203.0.113.10', 'a', ?, 'b')`).run(now())
    upsertUser(db, 1, 'a')
    upsertUser(db, 2, 'b')
    db.prepare(`UPDATE users SET status = 'suspended' WHERE tg_id = 2`).run()
    db.prepare(`
      INSERT INTO client_configs (id, tg_id, name, address, private_key, public_key, preshared_key, issued_via, created_at)
      VALUES ('c1', 1, 'phone', '10.66.0.2', 'p', 'P', 's', 'bot', ?)
    `).run(now())
    db.prepare(`INSERT INTO device_tokens (token_hash, tg_id, app_version, created_at, last_seen_at) VALUES ('h1', 1, '4.8.1', ?, ?)`).run(now(), now())

    expect(await handleAdminCommand(ctx, deps, msg('/status'))).toBe(true)
    const text = sent[0].text
    expect(text).toContain('Площадка main: degraded')
    expect(text).toContain('main/local (203.0.113.10): фаза ready, здоровье ok')
    expect(text).toContain('abcdef01')
    expect(text).not.toContain('x'.repeat(300))
    expect(text).toContain('неудач подряд: 3')
    expect(text).toContain('/trust main/local')
    expect(text).toContain('main/remote: ещё не настраивался')
    expect(text).toContain('активных 1, приостановлено 1')
    expect(text).toContain('Активных конфигов: 1')
    expect(text).toContain('4.8.1 — 1')
  })

  it('/apply and /apply upgrade report per node', async () => {
    const { ctx, deps, sent, control } = setup()
    await handleAdminCommand(ctx, deps, msg('/apply'))
    expect(control.applyNow).toHaveBeenCalledWith({ upgrade: false })
    expect(sent[0].text).toBe('Применяю…')
    expect(sent[1].text).toContain('main/local: применено')
    expect(sent[1].text).toContain('main/remote: ОШИБКА — ssh timeout')

    await handleAdminCommand(ctx, deps, msg('/apply upgrade'))
    expect(control.applyNow).toHaveBeenLastCalledWith({ upgrade: true })
  })

  it('/apply reports a thrown error', async () => {
    const { ctx, deps, sent, control } = setup()
    vi.mocked(control.applyNow).mockRejectedValueOnce(new Error('config invalid'))
    await handleAdminCommand(ctx, deps, msg('/apply'))
    expect(sent[1].text).toContain('config invalid')
  })

  it('/trust validates the node name', async () => {
    const { ctx, deps, sent, control } = setup()
    await handleAdminCommand(ctx, deps, msg('/trust nope/local'))
    expect(control.trust).not.toHaveBeenCalled()
    expect(sent[0].text).toContain('main/local, main/remote')

    await handleAdminCommand(ctx, deps, msg('/trust main/remote'))
    expect(control.trust).toHaveBeenCalledWith('main/remote')
  })

  it('/rotate asks for confirmation, then rotates on the callback', async () => {
    const { ctx, deps, sent, control } = setup()
    await handleAdminCommand(ctx, deps, msg('/rotate clients'))
    expect(control.rotate).not.toHaveBeenCalled()
    expect(sent[0].text).toContain('Изменятся все клиентские конфиги')
    const markup = (sent[0].opts as TelegramBot.SendMessageOptions).reply_markup as TelegramBot.InlineKeyboardMarkup
    expect(markup.inline_keyboard[0][0].callback_data).toBe('rotate_confirm:clients')

    const query: TelegramBot.CallbackQuery = {
      id: 'q', chat_instance: 'c', data: 'rotate_confirm:clients',
      from: { id: ADMIN, is_bot: false, first_name: 'x' },
      message: msg('...'),
    }
    expect(await handleAdminCallback(ctx, deps, query)).toBe(true)
    expect(control.rotate).toHaveBeenCalledWith('clients')
    expect(deps.messenger.editMessageText).toHaveBeenCalled()
    expect(sent.at(-1)!.text).toContain('main/local: применено')
  })

  it('rotate callback is refused for non-admins and ignores foreign callbacks', async () => {
    const { ctx, deps, control } = setup()
    const from = { id: USER, is_bot: false, first_name: 'x' }
    expect(await handleAdminCallback(ctx, deps, { id: 'q', chat_instance: 'c', data: 'rotate_confirm:tunnel', from })).toBe(true)
    expect(control.rotate).not.toHaveBeenCalled()
    expect(deps.messenger.answerCallbackQuery).toHaveBeenCalledWith('q', 'Недоступно')
    expect(await handleAdminCallback(ctx, deps, { id: 'q', chat_instance: 'c', data: 'revoke_token:abc', from })).toBe(false)
  })

  it('/revoke_user by username and by id', async () => {
    const { ctx, deps, sent } = setup()
    upsertUser(ctx.db, 7, 'Bob')
    upsertUser(ctx.db, 8, null)
    await handleAdminCommand(ctx, deps, msg('/revoke_user @bob'))
    expect(getUser(ctx.db, 7)!.status).toBe('suspended')
    expect(sent[0].text).toContain('@Bob (7) отозван: конфигов 0, токенов устройств 0')

    await handleAdminCommand(ctx, deps, msg('/revoke_user 8'))
    expect(getUser(ctx.db, 8)!.status).toBe('suspended')

    await handleAdminCommand(ctx, deps, msg('/revoke_user @ghost'))
    expect(sent.at(-1)!.text).toContain('не найден')
  })

  it('/backup sends the file and deletes it', async () => {
    const { ctx, deps, docs } = setup()
    let file = ''
    deps.backup.mockImplementationOnce(async () => {
      const result = await tmpBackup()()
      file = result.file
      return result
    })
    await handleAdminCommand(ctx, deps, msg('/backup'))
    expect(docs[0].buf.toString()).toBe('encrypted')
    expect(docs[0].filename).toBe('vpn-backup-x.tar.age')
    expect(fs.existsSync(file)).toBe(false)
  })

  it('/backup reports failures', async () => {
    const { ctx, deps, sent } = setup()
    deps.backup.mockRejectedValueOnce(new Error('backup.pub not found'))
    await handleAdminCommand(ctx, deps, msg('/backup'))
    expect(sent[0].text).toContain('backup.pub not found')
  })
})

describe('sendDailyBackup', () => {
  it('sends to every admin with a dated caption', async () => {
    const { ctx, deps, docs } = setup()
    await sendDailyBackup(ctx, deps, new Date('2026-10-12T03:00:00Z'))
    expect(docs.map(d => d.chatId)).toEqual(exampleConfig().telegram.admins)
    expect(docs[0].caption).toBe('Ежедневный бэкап 2026-10-12')
    expect(ctx.alert).not.toHaveBeenCalled()
  })

  it('alerts when the backup fails', async () => {
    const { ctx, deps } = setup()
    deps.backup.mockRejectedValueOnce(new Error('age missing'))
    await sendDailyBackup(ctx, deps)
    expect(ctx.alert).toHaveBeenCalledWith(expect.stringContaining('age missing'))
  })
})
