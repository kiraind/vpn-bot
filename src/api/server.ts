import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import type { AppContext } from '../context'
import { LoginRateLimiter, authenticateToken, redeemLoginCode, revokeToken } from '../services/auth'
import {
  configStatus, configSummary, configView, createConfig, getOwnConfig, listConfigs, markDelivered, revokeConfig,
} from '../services/configs'
import { ensureMemberFresh, type MemberChecker } from '../services/membership'

// Client API for the AmneziaVPN fork (spec 9). The contract is shared with old app builds
// in the wild, so changes here must stay backward compatible (R-A10).

export interface ApiDeps {
  checker: MemberChecker
  limiter?: LoginRateLimiter
}

export type ApiErrorCode =
  | 'invalid_request' | 'invalid_code' | 'rate_limited' | 'invalid_token' | 'not_member'
  | 'not_found' | 'name_taken' | 'invalid_name' | 'internal'

const MESSAGES: Record<ApiErrorCode, string> = {
  invalid_request: 'Invalid request',
  invalid_code: 'Invalid or expired login code',
  rate_limited: 'Too many attempts, try again in a minute',
  invalid_token: 'Missing, unknown or revoked device token',
  not_member: 'Not a member of the chat',
  not_found: 'Config not found',
  name_taken: 'Config name already taken',
  invalid_name: 'Config name must match [a-z0-9-]{1,32}',
  internal: 'Internal error',
}

class ApiError extends Error {
  constructor(public statusCode: number, public code: ApiErrorCode, message = MESSAGES[code]) {
    super(message)
  }
}

function send(reply: FastifyReply, status: number, code: ApiErrorCode, message = MESSAGES[code]) {
  return reply.code(status).send({ error: { code, message } })
}

interface Auth {
  tgId: number
  username: string | null
  tokenHash: string
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: Auth | null
  }
}

function appVersion(req: FastifyRequest): string | undefined {
  const v = req.headers['x-app-version']
  const s = Array.isArray(v) ? v[0] : v
  return s ? s.slice(0, 64) : undefined
}

function bearer(req: FastifyRequest): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '')
  return m ? m[1] : null
}

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
} as const

export function buildApi(ctx: AppContext, deps: ApiDeps): FastifyInstance {
  const limiter = deps.limiter ?? new LoginRateLimiter()
  // No type coercion: `{ code: 5 }` is a bad request, not the code "5"
  const app = Fastify({ trustProxy: 'loopback', logger: false, bodyLimit: 16 * 1024, ajv: { customOptions: { coerceTypes: false } } })

  app.decorateRequest('auth', null)

  // Clients may send `Content-Type: application/json` with no body on logout/delete
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = (body as string).trim()
    if(!text) return done(null, undefined)
    try {
      done(null, JSON.parse(text))
    } catch {
      done(new ApiError(400, 'invalid_request', 'Malformed JSON'), undefined)
    }
  })

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if(err instanceof ApiError) return send(reply, err.statusCode, err.code, err.message)
    // Schema validation, malformed JSON, wrong content type, oversized body...
    if(err.validation || (err.statusCode && err.statusCode >= 400 && err.statusCode < 500)) {
      return send(reply, err.statusCode ?? 400, 'invalid_request', err.message)
    }
    console.error(`api ${req.method} ${req.url} failed:`, err)
    return send(reply, 500, 'internal')
  })

  app.setNotFoundHandler((req, reply) => send(reply, 404, 'not_found', 'No such endpoint'))

  app.get('/healthz', async () => ({ ok: true }))

  app.register(async (v1) => {
    v1.post<{ Body: { code: string, deviceLabel?: string } }>('/auth/login', {
      schema: {
        body: {
          type: 'object',
          required: ['code'],
          properties: {
            code: { type: 'string', minLength: 1, maxLength: 32 },
            deviceLabel: { type: 'string', maxLength: 64 },
          },
        },
      },
    }, async (req, reply) => {
      const res = redeemLoginCode(ctx.db, {
        code: req.body.code,
        deviceLabel: req.body.deviceLabel,
        appVersion: appVersion(req),
        ip: req.ip,
      }, limiter)
      if(!res.ok) return res.error === 'rate_limited' ? send(reply, 429, 'rate_limited') : send(reply, 400, 'invalid_code')
      return { token: res.token, user: res.user }
    })

    // Everything below needs a token; logout only needs a valid token, not membership
    v1.register(async (authed) => {
      authed.addHook('onRequest', async (req) => {
        const token = bearer(req)
        if(!token) throw new ApiError(401, 'invalid_token')
        const res = authenticateToken(ctx.db, token, { appVersion: appVersion(req) })
        if(!res.ok) throw new ApiError(401, 'invalid_token')
        req.auth = { tgId: res.tgId, username: res.username, tokenHash: res.tokenHash }

        if(req.routeOptions.url === '/v1/auth/logout') return
        if(await ensureMemberFresh(ctx, deps.checker, res.tgId) === 'not-member') throw new ApiError(403, 'not_member')
      })

      authed.post('/auth/logout', async (req, reply) => {
        revokeToken(ctx.db, req.auth!.tokenHash)
        return reply.code(204).send()
      })

      authed.get('/me', async (req) => {
        const { tgId, username } = req.auth!
        return { user: { tgId, username }, configs: listConfigs(ctx.db, tgId).map(row => configSummary(ctx, row)) }
      })

      authed.post<{ Body: { name: string } }>('/configs', {
        schema: {
          body: {
            type: 'object',
            required: ['name'],
            // The name pattern is checked by createConfig so it comes back as invalid_name, not invalid_request
            properties: { name: { type: 'string' } },
          },
        },
      }, async (req, reply) => {
        const row = createConfig(ctx, { tgId: req.auth!.tgId, name: req.body.name, issuedVia: 'api' })
        if('error' in row) {
          if(row.error === 'name_taken') return send(reply, 409, 'name_taken')
          if(row.error === 'not_member') return send(reply, 403, 'not_member')
          return send(reply, 400, 'invalid_name')
        }
        const view = configView(ctx, row)
        markDelivered(ctx.db, row.id, view.revision, 'api')
        return reply.code(201).send(view)
      })

      authed.get<{ Params: { id: string } }>('/configs/:id', { schema: { params: idParams } }, async (req) => {
        const row = getOwnConfig(ctx.db, req.auth!.tgId, req.params.id)
        // Suspended configs are still served; the status endpoint tells the app why they don't work
        if(!row || row.state === 'revoked') throw new ApiError(404, 'not_found')
        const view = configView(ctx, row)
        markDelivered(ctx.db, row.id, view.revision, 'api')
        return view
      })

      authed.get<{ Params: { id: string }, Querystring: { revision?: string } }>('/configs/:id/status', {
        schema: {
          params: idParams,
          querystring: { type: 'object', properties: { revision: { type: 'string', maxLength: 64 } } },
        },
      }, async (req) => {
        const row = getOwnConfig(ctx.db, req.auth!.tgId, req.params.id)
        if(!row) throw new ApiError(404, 'not_found')
        return configStatus(ctx, row, req.query.revision)
      })

      authed.delete<{ Params: { id: string } }>('/configs/:id', { schema: { params: idParams } }, async (req, reply) => {
        if(!revokeConfig(ctx, req.auth!.tgId, req.params.id)) throw new ApiError(404, 'not_found')
        return reply.code(204).send()
      })
    })
  }, { prefix: '/v1' })

  return app
}
