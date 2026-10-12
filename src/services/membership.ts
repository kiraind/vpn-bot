import type { AppContext } from '../context'
import { now } from '../db'
import { getUser, listUsers, markMembershipChecked, suspendUser } from './users'

// Chat membership is the only access control (R-B1, R-B2, R-A3). A failed Telegram call is
// 'unknown', never 'not-member': an API outage must not suspend everyone.

export type MembershipStatus = 'member' | 'not-member' | 'unknown'

export interface MembershipResult {
  status: MembershipStatus
  reason: string
}

export type MemberChecker = (tgId: number) => Promise<MembershipResult>

export interface ChatMemberLike {
  status: string
  is_member?: boolean
}

export function isMemberStatus(member: ChatMemberLike): boolean {
  return member.status === 'member' ||
    member.status === 'administrator' ||
    member.status === 'creator' ||
    (member.status === 'restricted' && member.is_member === true)
}

export function createTelegramMemberChecker(
  getChatMember: (chatId: number | string, userId: number) => Promise<ChatMemberLike>,
  chatId: number | string,
  opts: { retries?: number, delayMs?: number } = {},
): MemberChecker {
  const retries = Math.max(1, opts.retries ?? 5)
  const delayMs = opts.delayMs ?? 5000

  return async (tgId) => {
    let reason = 'unknown'

    for(let i = 0; i < retries; i += 1) {
      try {
        const member = await getChatMember(chatId, tgId)

        return isMemberStatus(member)
          ? { status: 'member', reason: member.status }
          : { status: 'not-member', reason: member.status }
      } catch(e) {
        reason = e instanceof Error ? e.message : String(e)

        if(i !== retries - 1 && delayMs > 0) {
          await new Promise((res) => setTimeout(res, delayMs))
        }
      }
    }

    return { status: 'unknown', reason: `check failed: ${reason}` }
  }
}

export interface SweepResult {
  checked: number
  suspended: number
  unknown: number
}

/** Hourly sweep (R-B1). Rejoined users are not reactivated here: that happens on their next bot contact. */
export async function sweepMembership(ctx: AppContext, checker: MemberChecker): Promise<SweepResult> {
  const result: SweepResult = { checked: 0, suspended: 0, unknown: 0 }

  for(const user of listUsers(ctx.db)) {
    const { status, reason } = await checker(user.tg_id)

    if(status === 'unknown') {
      result.unknown += 1
      console.warn(`${now()} membership check for ${user.tg_id} failed: ${reason}`)
      continue
    }

    result.checked += 1
    markMembershipChecked(ctx.db, user.tg_id, now())

    if(status === 'not-member' && user.status === 'active') {
      const { configs, tokens } = suspendUser(ctx, user.tg_id)
      result.suspended += 1
      console.log(`${now()} suspended ${user.tg_id} (@${user.username ?? '-'}): ${configs} config(s), ${tokens} token(s), reason: ${reason}`)
    }
  }

  return result
}

/** API gate (R-A3): cached answer if checked within maxAgeMs, else a live check. */
export async function ensureMemberFresh(
  ctx: AppContext,
  checker: MemberChecker,
  tgId: number,
  maxAgeMs = 3600_000,
): Promise<'member' | 'not-member'> {
  const user = getUser(ctx.db, tgId)
  if(!user) {
    return 'not-member'
  }

  if(user.status === 'suspended') {
    return 'not-member'
  }

  const checkedAt = user.membership_checked_at ? Date.parse(user.membership_checked_at) : NaN
  if(Number.isFinite(checkedAt) && Date.now() - checkedAt < maxAgeMs) {
    return 'member'
  }

  const { status, reason } = await checker(tgId)

  if(status === 'unknown') {
    // Telegram is unreachable: trust the cached (active) status rather than lock everyone out.
    return 'member'
  }

  markMembershipChecked(ctx.db, tgId, now())

  if(status === 'not-member') {
    suspendUser(ctx, tgId)
    console.log(`${now()} suspended ${tgId} on API access, reason: ${reason}`)
    return 'not-member'
  }

  return 'member'
}

export interface ChatMemberUpdateLike {
  new_chat_member: ChatMemberLike & { user: { id: number } }
}

/** `chat_member` update (bot is chat admin, R-B2): instant suspension on leave/kick. Returns true if suspended. */
export function handleChatMemberUpdate(ctx: AppContext, update: ChatMemberUpdateLike): boolean {
  const member = update.new_chat_member
  const tgId = member.user.id
  const user = getUser(ctx.db, tgId)

  if(!user) {
    return false
  }

  markMembershipChecked(ctx.db, tgId, now())

  if(isMemberStatus(member) || user.status !== 'active') {
    return false
  }

  const { configs, tokens } = suspendUser(ctx, tgId)
  console.log(`${now()} suspended ${tgId} (@${user.username ?? '-'}) on chat_member ${member.status}: ${configs} config(s), ${tokens} token(s)`)

  return true
}
