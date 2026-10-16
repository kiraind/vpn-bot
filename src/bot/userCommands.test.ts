import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type TelegramBot from 'node-telegram-bot-api'
import { openDb } from '../db'
import { createEvents, type AppContext } from '../context'
import type { MemberChecker, MembershipStatus } from '../services/membership'
import { ensureSiteIdentities, rotateParams } from '../services/identity'
import { exampleConfig } from '../services/testFixtures'
import { getUser, revokeUser, suspendUser, upsertUser } from '../services/users'
import { configView, createConfig, findConfigByName, getOwnConfig, listConfigs } from '../services/configs'
import { listTokens } from '../services/auth'
import { hashSecret } from '../crypto/tokens'
import type { ClientConfigRow } from '../types'
import type { Messenger } from './messenger'
import {
  AUTO_DELETE_MS, drainPendingDeletions, escapeMd, handleUserCallback, handleUserMessage, resendStaleBotConfigs,
} from './userCommands'

const ALICE = 101

interface Call { method: string, args: unknown[] }

function fakeMessenger() {
  const calls: Call[] = []
  let nextId = 1
  const record = (method: string) => async (...args: unknown[]) => {
    calls.push({ method, args })
    return nextId++
  }
  const messenger: Messenger = {
    sendMessage: record('sendMessage'),
    sendPhoto: record('sendPhoto'),
    sendDocument: record('sendDocument'),
    deleteMessage: async (...args) => { calls.push({ method: 'deleteMessage', args }) },
    answerCallbackQuery: async (...args) => { calls.push({ method: 'answerCallbackQuery', args }) },
    editMessageText: async (...args) => { calls.push({ method: 'editMessageText', args }) },
  }
  const of = (method: string) => calls.filter(c => c.method === method)
  const texts = () => of('sendMessage').map(c => c.args[1] as string)
  return { messenger, calls, of, texts }
}

function setup(status: MembershipStatus = 'member') {
  const db = openDb(':memory:')
  const config = exampleConfig()
  ensureSiteIdentities(db, config)
  const ctx: AppContext = { db, config: () => config, events: createEvents(), alert: async () => {} }
  const fake = fakeMessenger()
  const checker = vi.fn<MemberChecker>(async () => ({ status, reason: status }))
  const deps = { messenger: fake.messenger, checker }
  const send = (text: string, opts: { chatId?: number, username?: string } = {}) =>
    handleUserMessage(ctx, deps, {
      message_id: 1, date: 0, text,
      chat: { id: opts.chatId ?? ALICE, type: 'private' },
      from: { id: ALICE, is_bot: false, first_name: 'Alice', username: opts.username },
    } as TelegramBot.Message)
  return { ctx, deps, checker, send, ...fake }
}

function create(ctx: AppContext, name: string): ClientConfigRow {
  const row = createConfig(ctx, { tgId: ALICE, name, issuedVia: 'bot' })
  if('error' in row) throw new Error(row.error)
  return row
}

function addToken(ctx: AppContext, token: string, label: string | null) {
  ctx.db.prepare('INSERT INTO device_tokens (token_hash, tg_id, label, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
    .run(hashSecret(token), ALICE, label, '2026-10-01T10:00:00.000Z', '2026-10-02T11:30:00.000Z')
  return hashSecret(token)
}

/** Every MarkdownV2 special char outside `code` spans must be escaped. */
function assertValidMarkdownV2(text: string) {
  const outside = text.replace(/`(?:[^`\\]|\\.)*`/g, '')
  expect(outside.replace(/\\./g, '')).not.toMatch(/[_*[\]()~`>#+\-=|{}.!]/)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('access', () => {
  it('ignores non-DMs', async () => {
    const t = setup()
    await t.send('/start', { chatId: -100 })
    expect(t.calls).toEqual([])
    expect(t.checker).not.toHaveBeenCalled()
  })

  it('turns away non-members without creating a user', async () => {
    const t = setup('not-member')
    await t.send('/start')
    expect(t.texts()).toEqual(['Сорри, тебя нет в списках'])
    expect(getUser(t.ctx.db, ALICE)).toBeNull()
  })

  it('suspends a known active user who left', async () => {
    const t = setup('not-member')
    upsertUser(t.ctx.db, ALICE, 'alice')
    create(t.ctx, 'phone')
    await t.send('/add laptop')
    expect(t.texts()).toEqual(['Сорри, тебя нет в списках'])
    expect(getUser(t.ctx.db, ALICE)?.status).toBe('suspended')
    expect(findConfigByName(t.ctx.db, ALICE, 'laptop')).toBeNull()
  })

  it('on a failed check trusts only a cached active user', async () => {
    const t = setup('unknown')
    await t.send('/start')
    expect(t.texts()[0]).toMatch(/Не получилось проверить/)

    upsertUser(t.ctx.db, ALICE, 'alice')
    suspendUser(t.ctx, ALICE)
    await t.send('/start')
    expect(t.texts()[1]).toMatch(/Не получилось проверить/)
    expect(getUser(t.ctx.db, ALICE)?.status).toBe('suspended')

    const u = setup('unknown')
    upsertUser(u.ctx.db, ALICE, 'alice')
    await u.send('/start')
    expect(u.texts()[0]).toMatch(/Твои устройства|нет активных/)
  })

  it('works without a username and stores it when present', async () => {
    const t = setup()
    await t.send('/start')
    expect(getUser(t.ctx.db, ALICE)?.username).toBeNull()
    expect(t.ctx.db.prepare('SELECT membership_checked_at FROM users').get()).not.toEqual({ membership_checked_at: null })
    await t.send('/start', { username: 'alice' })
    expect(getUser(t.ctx.db, ALICE)?.username).toBe('alice')
  })

  it('reactivates a returning suspended member before handling', async () => {
    const t = setup()
    upsertUser(t.ctx.db, ALICE, 'alice')
    create(t.ctx, 'phone')
    suspendUser(t.ctx, ALICE)
    const peers = vi.fn()
    t.ctx.events.on('peers-changed', peers)
    await t.send('/info')
    expect(getUser(t.ctx.db, ALICE)?.status).toBe('active')
    expect(listConfigs(t.ctx.db, ALICE).map(r => r.state)).toEqual(['active'])
    expect(peers).toHaveBeenCalled()
    expect(t.texts()[0]).toContain('`phone` — работает')
  })
})

describe('/start, /info', () => {
  it('lists devices and commands in valid MarkdownV2', async () => {
    const t = setup()
    await t.send('/start')
    upsertUser(t.ctx.db, ALICE, null)
    create(t.ctx, 'my-phone')
    await t.send('/info@SomeBot')
    const [empty, full] = t.of('sendMessage')
    expect(empty.args[1]).toContain('нет активных устройств')
    expect(full.args[1]).toContain('📲 `my-phone`')
    expect(full.args[2]).toEqual({ parse_mode: 'MarkdownV2' })
    for(const c of [empty, full]) assertValidMarkdownV2(c.args[1] as string)
  })

  it('escapes MarkdownV2 specials', () => {
    expect(escapeMd('a.b-c (d)!')).toBe('a\\.b\\-c \\(d\\)\\!')
  })
})

describe('/add', () => {
  it('sends QR, .conf and warning, deletes them after 5 minutes, marks delivered', async () => {
    const t = setup()
    await t.send('/add Phone')
    const row = findConfigByName(t.ctx.db, ALICE, 'phone')!
    expect(row.issued_via).toBe('bot')
    expect(row.delivered_revision).toBe(configView(t.ctx, row).revision)

    expect(t.calls.map(c => c.method)).toEqual(['sendMessage', 'sendPhoto', 'sendDocument', 'sendMessage'])
    expect(t.texts()[0]).toMatch(/нескольких секунд/)
    const [photo] = t.of('sendPhoto')
    expect((photo.args[1] as Buffer).subarray(1, 4).toString()).toBe('PNG')
    const [doc] = t.of('sendDocument')
    expect(doc.args[2]).toBe('phone-amnezia.conf')
    expect((doc.args[1] as Buffer).toString()).toBe(configView(t.ctx, row).awg)
    expect(t.texts()[1]).toMatch(/удалятся через 5 минут/)

    vi.advanceTimersByTime(AUTO_DELETE_MS - 1)
    expect(t.of('deleteMessage')).toEqual([])
    vi.advanceTimersByTime(1)
    expect(t.of('deleteMessage').map(c => c.args)).toEqual([[ALICE, 2], [ALICE, 3], [ALICE, 4]])
  })

  it('explains invalid and taken names', async () => {
    const t = setup()
    await t.send('/add')
    await t.send('/add bad_name')
    await t.send('/add phone')
    t.calls.length = 0
    await t.send('/add phone')
    expect(t.texts()).toEqual(['Устройство с таким именем уже есть'])
    expect(t.of('sendMessage').length).toBe(1)
  })

  it('hints the name format', async () => {
    const t = setup()
    await t.send('/add bad_name')
    expect(t.texts()[0]).toContain('[a-z0-9-]{1,32}')
    expect(listConfigs(t.ctx.db, ALICE)).toEqual([])
  })
})

describe('/remove', () => {
  it('revokes own device by name', async () => {
    const t = setup()
    upsertUser(t.ctx.db, ALICE, null)
    const row = create(t.ctx, 'phone')
    await t.send('/remove nope')
    await t.send('/remove phone')
    expect(t.texts()).toEqual(['Устройства с таким именем нет :(', 'Готово!'])
    expect(getOwnConfig(t.ctx.db, ALICE, row.id)?.state).toBe('revoked')
  })
})

describe('/rename', () => {
  it('renames own device, explains unknown, taken and invalid names', async () => {
    const t = setup()
    upsertUser(t.ctx.db, ALICE, null)
    const row = create(t.ctx, 'android')
    create(t.ctx, 'laptop')
    await t.send('/rename nope pixel')
    await t.send('/rename android laptop')
    await t.send('/rename android bad_name')
    await t.send('/rename android')
    await t.send('/rename Android Pixel-8')
    const texts = t.texts()
    expect(texts.slice(0, 2)).toEqual(['Устройства с таким именем нет :(', 'Устройство с таким именем уже есть'])
    for(const hint of texts.slice(2, 4)) {
      expect(hint).toContain('[a-z0-9-]{1,32}')
      expect(hint).toContain('/rename android pixel-8')
    }
    expect(texts[4]).toBe('Готово! Теперь устройство называется pixel-8')
    expect(getOwnConfig(t.ctx.db, ALICE, row.id)?.name).toBe('pixel-8')
    // Nothing is resent: the conf itself didn't change
    expect(t.of('sendDocument')).toEqual([])
  })
})

describe('/login', () => {
  it('replies with a one-time code', async () => {
    const t = setup()
    await t.send('/login')
    const [msg] = t.of('sendMessage')
    const code = /`([^`]+)`/.exec(msg.args[1] as string)![1]
    expect(code).toHaveLength(6)
    expect(t.ctx.db.prepare('SELECT tg_id FROM login_codes WHERE code_hash = ?').get(hashSecret(code))).toEqual({ tg_id: ALICE })
    expect(msg.args[1]).toMatch(/5 минут/)
    expect(msg.args[2]).toEqual({ parse_mode: 'MarkdownV2' })
    assertValidMarkdownV2(msg.args[1] as string)
  })
})

describe('/devices', () => {
  it('lists tokens with revoke buttons; the callback revokes and refreshes', async () => {
    const t = setup()
    await t.send('/devices')
    expect(t.texts()[0]).toMatch(/\/login/)

    const phone = addToken(t.ctx, 'tok-phone', 'iPhone')
    addToken(t.ctx, 'tok-mac', null)
    await t.send('/devices')
    const msg = t.of('sendMessage')[1]
    expect(msg.args[1]).toContain('iPhone — последний визит: 2026-10-02 11:30 UTC')
    expect(msg.args[1]).toContain('без названия')
    const keyboard = (msg.args[2] as TelegramBot.SendMessageOptions).reply_markup as TelegramBot.InlineKeyboardMarkup
    const button = keyboard.inline_keyboard.flat().find(b => b.text === 'Выйти: iPhone')!
    expect(button.callback_data).toBe(`revoke_token:${phone.slice(0, 8)}`)

    const query = {
      id: 'q1', chat_instance: 'x', data: button.callback_data,
      from: { id: ALICE, is_bot: false, first_name: 'Alice' },
      message: { message_id: 77, date: 0, chat: { id: ALICE, type: 'private' } },
    } as TelegramBot.CallbackQuery
    await handleUserCallback(t.ctx, t.deps, query)
    expect(listTokens(t.ctx.db, ALICE).map(r => r.label)).toEqual([null])
    expect(t.of('answerCallbackQuery')[0].args[0]).toBe('q1')
    const [edit] = t.of('editMessageText')
    expect(edit.args.slice(0, 2)).toEqual([ALICE, 77])
    expect(edit.args[2]).not.toContain('iPhone')
    const edited = (edit.args[3] as TelegramBot.EditMessageTextOptions).reply_markup!
    expect(edited.inline_keyboard.flat().map(b => b.text)).toEqual(['Выйти: без названия'])

    await handleUserCallback(t.ctx, t.deps, query)
    expect(t.of('answerCallbackQuery')[1].args[1]).toMatch(/уже/)
  })

  it('refuses callbacks from non-members', async () => {
    const t = setup('not-member')
    upsertUser(t.ctx.db, ALICE, null)
    const hash = addToken(t.ctx, 'tok', 'x')
    await handleUserCallback(t.ctx, t.deps, {
      id: 'q', chat_instance: 'x', data: `revoke_token:${hash.slice(0, 8)}`,
      from: { id: ALICE, is_bot: false, first_name: 'A' },
      message: { message_id: 1, date: 0, chat: { id: ALICE, type: 'private' } },
    } as TelegramBot.CallbackQuery)
    expect(t.of('answerCallbackQuery')[0].args).toEqual(['q', 'Сорри, тебя нет в списках'])
    expect(t.of('editMessageText')).toEqual([])
  })
})

describe('other', () => {
  it('answers unknown commands', async () => {
    const t = setup()
    await t.send('hello')
    expect(t.texts()).toEqual(['Не понимаю, попробуй /start'])
  })
})

describe('resendStaleBotConfigs', () => {
  it('resends configs whose revision changed, once', async () => {
    const t = setup()
    await t.send('/add phone')
    t.calls.length = 0
    expect(await resendStaleBotConfigs(t.ctx, t.messenger)).toBe(0)

    rotateParams(t.ctx.db, 'main', 'clients')
    expect(await resendStaleBotConfigs(t.ctx, t.messenger)).toBe(1)
    expect(t.texts()[0]).toBe('Конфигурация сервера изменилась, вот обновлённый конфиг для phone. Старый больше не работает.\n\n'
      + 'Чтобы конфиги обновлялись автоматически, используйте приложение Лёша VPN.')
    expect(t.of('sendDocument')).toHaveLength(1)
    expect(await resendStaleBotConfigs(t.ctx, t.messenger)).toBe(0)
  })

  it('overlapping runs coalesce instead of sending the same config twice', async () => {
    const t = setup()
    await t.send('/add phone')
    t.calls.length = 0
    rotateParams(t.ctx.db, 'main', 'clients')
    await Promise.all([resendStaleBotConfigs(t.ctx, t.messenger), resendStaleBotConfigs(t.ctx, t.messenger)])
    expect(t.of('sendDocument')).toHaveLength(1)
  })

  it('keeps going when a send fails', async () => {
    const t = setup()
    await t.send('/add a')
    await t.send('/add b')
    rotateParams(t.ctx.db, 'main', 'clients')
    let fail = true
    const original = t.messenger.sendPhoto
    t.messenger.sendPhoto = async (...args) => {
      if(fail) { fail = false; throw new Error('blocked') }
      return original(...args)
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await resendStaleBotConfigs(t.ctx, t.messenger)).toBe(1)
    warn.mockRestore()
    vi.advanceTimersByTime(AUTO_DELETE_MS)
  })
})

describe('admin revocation (/revoke_user)', () => {
  it('is not undone by the next message from a chat member', async () => {
    const t = setup('member')
    upsertUser(t.ctx.db, ALICE, 'alice')
    create(t.ctx, 'phone')
    revokeUser(t.ctx, ALICE)

    await t.send('/add laptop')
    await t.send('/login')
    expect(t.texts()).toEqual(['Доступ отозван администратором.', 'Доступ отозван администратором.'])
    const user = getUser(t.ctx.db, ALICE)!
    expect(user.status).toBe('suspended')
    expect(user.revoked_at).not.toBeNull()
    expect(listConfigs(t.ctx.db, ALICE).filter(r => r.state !== 'revoked')).toEqual([])
    expect(t.ctx.db.prepare('SELECT COUNT(*) AS n FROM login_codes').get()).toEqual({ n: 0 })
  })

  it('also blocks /devices callbacks', async () => {
    const t = setup('member')
    upsertUser(t.ctx.db, ALICE, 'alice')
    revokeUser(t.ctx, ALICE)
    await handleUserCallback(t.ctx, t.deps, {
      id: 'q', chat_instance: 'x', data: 'revoke_token:abcdef01',
      from: { id: ALICE, is_bot: false, first_name: 'Alice' },
      message: { message_id: 5, date: 0, chat: { id: ALICE, type: 'private' } },
    } as TelegramBot.CallbackQuery)
    expect(t.of('answerCallbackQuery').map(c => c.args)).toEqual([['q', 'Доступ отозван администратором.']])
  })
})

describe('/add delivery failure', () => {
  it('revokes the new config and asks to retry', async () => {
    const t = setup()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    t.messenger.sendDocument = async () => { throw new Error('Forbidden: bot was blocked') }
    await t.send('/add phone')
    expect(findConfigByName(t.ctx.db, ALICE, 'phone')).toBeNull()
    expect(t.texts().at(-1)).toBe('Не получилось отправить конфиг, попробуй ещё раз.')

    // the name is free again and the QR that did go out is still cleaned up
    t.messenger.sendDocument = async () => 100
    await t.send('/add phone')
    expect(findConfigByName(t.ctx.db, ALICE, 'phone')?.state).toBe('active')
    vi.advanceTimersByTime(AUTO_DELETE_MS)
    expect(t.of('deleteMessage').map(c => c.args)).toContainEqual([ALICE, 2])
  })

  it('a suspension racing with /add gets the deny text', async () => {
    const t = setup()
    await t.send('/start')
    t.calls.length = 0
    // Suspends the user right after checkAccess passes, like a chat_member update landing mid-command
    t.ctx.db.prepare(`CREATE TEMP TRIGGER suspend_on_check AFTER UPDATE OF membership_checked_at ON users
      BEGIN UPDATE users SET status = 'suspended' WHERE tg_id = NEW.tg_id; END`).run()
    await t.send('/add phone')
    expect(t.texts()).toEqual(['Сорри, тебя нет в списках'])
    expect(findConfigByName(t.ctx.db, ALICE, 'phone')).toBeNull()
  })
})

describe('pending deletions (survive restarts)', () => {
  const pending = (t: ReturnType<typeof setup>) =>
    t.ctx.db.prepare('SELECT chat_id, message_id, delete_at FROM pending_deletions ORDER BY message_id').all() as
      { chat_id: number, message_id: number, delete_at: string }[]

  it('records sent config messages and the timer clears them', async () => {
    const t = setup()
    await t.send('/add phone')
    expect(pending(t).map(r => r.message_id)).toEqual([2, 3, 4])
    vi.advanceTimersByTime(AUTO_DELETE_MS)
    expect(pending(t)).toEqual([])
    expect(t.of('deleteMessage')).toHaveLength(3)
  })

  it('drain deletes due rows once, ignores errors, skips too-old ones', async () => {
    const t = setup()
    const nowAt = new Date('2026-10-12T12:00:00.000Z')
    const ins = t.ctx.db.prepare('INSERT INTO pending_deletions (chat_id, message_id, delete_at) VALUES (?, ?, ?)')
    ins.run(ALICE, 1, '2026-10-12T11:59:00.000Z') // due
    ins.run(ALICE, 2, '2026-10-12T11:00:00.000Z') // due, Telegram fails
    ins.run(ALICE, 3, '2026-10-12T12:05:00.000Z') // not yet
    ins.run(ALICE, 4, '2026-10-10T12:00:00.000Z') // 48h old: dropped without trying
    const deleteMessage = vi.fn(async (_chat: unknown, id: number) => {
      if(id === 2) throw new Error('message to delete not found')
    })
    t.messenger.deleteMessage = deleteMessage

    expect(await drainPendingDeletions(t.ctx, t.messenger, nowAt)).toBe(2)
    expect(deleteMessage.mock.calls.map(c => c[1]).sort()).toEqual([1, 2])
    expect(pending(t).map(r => r.message_id)).toEqual([3])

    expect(await drainPendingDeletions(t.ctx, t.messenger, nowAt)).toBe(0)
    expect(await drainPendingDeletions(t.ctx, t.messenger, new Date('2026-10-12T12:05:00.000Z'))).toBe(1)
    expect(pending(t)).toEqual([])
  })

  it('a drain after restart deletes what the lost timer would have', async () => {
    const t = setup()
    await t.send('/add phone')
    vi.clearAllTimers() // the process died
    expect(await drainPendingDeletions(t.ctx, t.messenger, new Date(Date.now() + AUTO_DELETE_MS))).toBe(3)
    expect(t.of('deleteMessage').map(c => c.args)).toEqual([[ALICE, 2], [ALICE, 3], [ALICE, 4]])
  })
})
