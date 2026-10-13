import type { AppContext } from '../context'
import type { NetworkState } from '../types'

// R-H4 wording. Admin text is technical; the users' chat gets a short plain phrase.

const ADMIN_REASON: Record<NetworkState, string> = {
  ok: 'всё работает',
  degraded: 'туннель до REMOTE не отвечает, работает только домашний трафик',
  down: 'LOCAL недоступен',
}

const ANNOUNCE: Record<NetworkState, string> = {
  ok: 'VPN снова работает полностью.',
  degraded: 'Зарубежные сайты сейчас недоступны, остальное работает. Уже чиним.',
  down: 'VPN сейчас недоступен. Уже чиним.',
}

export function siteTransitionMessages(site: string, from: NetworkState, to: NetworkState, detail?: string): { admin: string, announce: string | null } {
  const admin = `площадка ${site}: ${from} → ${to} (${ADMIN_REASON[to]})` + (detail ? `\n${detail}` : '')

  return { admin, announce: from === to ? null : ANNOUNCE[to] }
}

/**
 * Admin alert always; the users' chat only when announceOutages is on. Relies on
 * `alert(text, { announce: true })` posting to the users' chat only (not admins again).
 */
export async function notifyTransition(ctx: AppContext, site: string, from: NetworkState, to: NetworkState, detail?: string): Promise<void> {
  const { admin, announce } = siteTransitionMessages(site, from, to, detail)

  await ctx.alert(admin)

  if(announce && ctx.config().telegram.announceOutages) {
    await ctx.alert(announce, { announce: true })
  }
}
