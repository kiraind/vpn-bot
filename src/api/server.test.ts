import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { openDb } from '../db'
import { createEvents, type AppContext } from '../context'
import { LoginRateLimiter, issueLoginCode, listTokens } from '../services/auth'
import { createConfig } from '../services/configs'
import { ensureSiteIdentities } from '../services/identity'
import type { MembershipStatus } from '../services/membership'
import { exampleConfig } from '../services/testFixtures'
import { getUser, upsertUser } from '../services/users'
import { buildApi } from './server'

let ctx: AppContext
let app: FastifyInstance
let membership: Map<number, MembershipStatus>

beforeEach(() => {
  const db = openDb(':memory:')
  const config = exampleConfig()
  ensureSiteIdentities(db, config)
  upsertUser(db, 1, 'alice')
  upsertUser(db, 2, 'bob')
  ctx = { db, config: () => config, events: createEvents(), alert: async () => {} }
  membership = new Map([[1, 'member'], [2, 'member']])
  app = buildApi(ctx, {
    checker: async tgId => ({ status: membership.get(tgId) ?? 'not-member', reason: 'test' }),
    limiter: new LoginRateLimiter(),
  })
})

afterEach(() => app.close())

async function login(tgId = 1, ip = '10.0.0.1'): Promise<string> {
  const { code } = issueLoginCode(ctx.db, tgId)
  const res = await app.inject({
    method: 'POST', url: '/v1/auth/login', payload: { code, deviceLabel: 'Pixel' },
    headers: { 'x-app-version': '4.8.1', 'x-forwarded-for': ip },
  })
  expect(res.statusCode).toBe(200)
  return res.json().token
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` })

describe('health', () => {
  it('needs no auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })
})

describe('login', () => {
  it('returns a token and stores label and app version (R-O6)', async () => {
    const { code } = issueLoginCode(ctx.db, 1)
    const res = await app.inject({
      method: 'POST', url: '/v1/auth/login', payload: { code, deviceLabel: 'Pixel' }, headers: { 'x-app-version': '4.8.1' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.user).toEqual({ tgId: 1, username: 'alice' })
    expect(typeof body.token).toBe('string')
    const [row] = listTokens(ctx.db, 1)
    expect(row.label).toBe('Pixel')
    expect(row.app_version).toBe('4.8.1')
  })

  it('rejects an invalid code', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { code: 'ZZZZZZ' } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: { code: 'invalid_code', message: expect.any(String) } })
  })

  it('rejects bad bodies with the error envelope', async () => {
    for(const payload of [{}, { code: 5 }, { code: 'ABCDEF', deviceLabel: 'x'.repeat(65) }]) {
      const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload })
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('invalid_request')
    }
    const res = await app.inject({
      method: 'POST', url: '/v1/auth/login', payload: '{nope', headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('invalid_request')
  })

  it('rate limits per client IP behind the proxy (R-A1)', async () => {
    const attempt = (ip: string) => app.inject({
      method: 'POST', url: '/v1/auth/login', payload: { code: 'ZZZZZZ' }, headers: { 'x-forwarded-for': ip },
    })
    for(let i = 0; i < 5; i++) expect((await attempt('9.9.9.9')).statusCode).toBe(400)
    const limited = await attempt('9.9.9.9')
    expect(limited.statusCode).toBe(429)
    expect(limited.json().error.code).toBe('rate_limited')
    expect((await attempt('8.8.8.8')).statusCode).toBe(400)
  })
})

describe('auth hook', () => {
  it('401 on missing, unknown and revoked tokens', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/me' })).json().error.code).toBe('invalid_token')
    const unknown = await app.inject({ method: 'GET', url: '/v1/me', headers: auth('nope') })
    expect(unknown.statusCode).toBe(401)
    expect(unknown.json().error.code).toBe('invalid_token')

    const token = await login()
    const out = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: auth(token) })
    expect(out.statusCode).toBe(204)
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: auth(token) })).statusCode).toBe(401)
  })

  it('logout tolerates an empty JSON body', async () => {
    const token = await login()
    const out = await app.inject({
      method: 'POST', url: '/v1/auth/logout', headers: { ...auth(token), 'content-type': 'application/json' },
    })
    expect(out.statusCode).toBe(204)
  })

  it('403 not_member when the user left the chat (R-A3), token is dead afterwards', async () => {
    const token = await login()
    membership.set(1, 'not-member')
    const res = await app.inject({ method: 'GET', url: '/v1/me', headers: auth(token) })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('not_member')
    expect(getUser(ctx.db, 1)!.status).toBe('suspended')
    // suspension revoked the token for good
    membership.set(1, 'member')
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: auth(token) })).statusCode).toBe(401)
  })

  it('updates the app version on every request (R-O6)', async () => {
    const token = await login()
    await app.inject({ method: 'GET', url: '/v1/me', headers: { ...auth(token), 'x-app-version': '4.9.0' } })
    expect(listTokens(ctx.db, 1)[0].app_version).toBe('4.9.0')
  })
})

describe('configs', () => {
  it('create, list, fetch, delete', async () => {
    const token = await login()
    const created = await app.inject({ method: 'POST', url: '/v1/configs', headers: auth(token), payload: { name: 'phone' } })
    expect(created.statusCode).toBe(201)
    const config = created.json()
    expect(config).toMatchObject({ name: 'phone', id: expect.any(String), revision: expect.any(String) })
    expect(config.awg).toContain('[Interface]')
    expect(config.vpnKey).toMatch(/^vpn:\/\//)
    expect(config.endpoint).toMatch(/:\d+$/)
    const row = ctx.db.prepare('SELECT issued_via, delivered_revision, api_fetched_at FROM client_configs WHERE id = ?')
      .get(config.id) as { issued_via: string, delivered_revision: string, api_fetched_at: string | null }
    expect(row.issued_via).toBe('api')
    expect(row.delivered_revision).toBe(config.revision)
    expect(row.api_fetched_at).not.toBeNull()

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: auth(token) })
    expect(me.json()).toEqual({
      user: { tgId: 1, username: 'alice' },
      configs: [{ id: config.id, name: 'phone', revision: config.revision, state: 'active', createdAt: config.createdAt }],
    })

    const fetched = await app.inject({ method: 'GET', url: `/v1/configs/${config.id}`, headers: auth(token) })
    expect(fetched.statusCode).toBe(200)
    expect(fetched.json()).toEqual(config)

    const del = await app.inject({ method: 'DELETE', url: `/v1/configs/${config.id}`, headers: auth(token) })
    expect(del.statusCode).toBe(204)
    expect((await app.inject({ method: 'DELETE', url: `/v1/configs/${config.id}`, headers: auth(token) })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: `/v1/configs/${config.id}`, headers: auth(token) })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: auth(token) })).json().configs).toEqual([])
  })

  it('shows bot-issued configs too (R-A9)', async () => {
    createConfig(ctx, { tgId: 1, name: 'laptop', issuedVia: 'bot' })
    const token = await login()
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: auth(token) })
    expect(me.json().configs.map((c: { name: string }) => c.name)).toEqual(['laptop'])
  })

  it('409 name_taken, 400 invalid_name, 400 invalid_request', async () => {
    const token = await login()
    await app.inject({ method: 'POST', url: '/v1/configs', headers: auth(token), payload: { name: 'phone' } })
    const taken = await app.inject({ method: 'POST', url: '/v1/configs', headers: auth(token), payload: { name: 'phone' } })
    expect(taken.statusCode).toBe(409)
    expect(taken.json().error.code).toBe('name_taken')
    const bad = await app.inject({ method: 'POST', url: '/v1/configs', headers: auth(token), payload: { name: 'Bad!' } })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error.code).toBe('invalid_name')
    const missing = await app.inject({ method: 'POST', url: '/v1/configs', headers: auth(token), payload: {} })
    expect(missing.statusCode).toBe(400)
    expect(missing.json().error.code).toBe('invalid_request')
  })

  it("someone else's config is 404 everywhere", async () => {
    const bobs = createConfig(ctx, { tgId: 2, name: 'phone', issuedVia: 'bot' })
    if('error' in bobs) throw new Error(bobs.error)
    const token = await login(1)
    for(const [method, url] of [
      ['GET', `/v1/configs/${bobs.id}`], ['GET', `/v1/configs/${bobs.id}/status`], ['DELETE', `/v1/configs/${bobs.id}`],
    ] as const) {
      const res = await app.inject({ method, url, headers: auth(token) })
      expect(res.statusCode).toBe(404)
      expect(res.json().error.code).toBe('not_found')
    }
    expect((ctx.db.prepare('SELECT state FROM client_configs WHERE id = ?').get(bobs.id) as { state: string }).state).toBe('active')
  })

  it('status: ok, outdated, revoked (R-A5)', async () => {
    const token = await login()
    const config = (await app.inject({ method: 'POST', url: '/v1/configs', headers: auth(token), payload: { name: 'phone' } })).json()
    const status = (rev?: string) => app.inject({
      method: 'GET', url: `/v1/configs/${config.id}/status${rev === undefined ? '' : `?revision=${rev}`}`, headers: auth(token),
    })

    const ok = await status(config.revision)
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ state: 'ok', revision: config.revision })
    expect(['ok', 'degraded', 'down']).toContain(ok.json().network)
    expect((await status('deadbeef')).json()).toMatchObject({ state: 'outdated', revision: config.revision })
    expect((await status()).json().state).toBe('outdated')

    await app.inject({ method: 'DELETE', url: `/v1/configs/${config.id}`, headers: auth(token) })
    const revoked = await status(config.revision)
    expect(revoked.statusCode).toBe(200)
    expect(revoked.json().state).toBe('revoked')
  })

  it('unknown routes use the error envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/v2/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('not_found')
  })
})

describe('configs membership race', () => {
  it('POST /v1/configs is 403 not_member when the user is suspended mid-request', async () => {
    const token = await login()
    // The live check passes but the user gets suspended right after (e.g. a chat_member update)
    const racing = buildApi(ctx, {
      checker: async tgId => {
        ctx.db.prepare(`UPDATE users SET status = 'suspended' WHERE tg_id = ?`).run(tgId)
        return { status: 'member', reason: 'test' }
      },
      limiter: new LoginRateLimiter(),
    })
    try {
      const res = await racing.inject({ method: 'POST', url: '/v1/configs', headers: auth(token), payload: { name: 'phone' } })
      expect(res.statusCode).toBe(403)
      expect(res.json().error.code).toBe('not_member')
    } finally {
      await racing.close()
    }
  })
})
