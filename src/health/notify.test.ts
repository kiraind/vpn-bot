import { describe, expect, it, vi } from 'vitest'
import type { AppContext } from '../context'
import { notifyTransition, siteTransitionMessages } from './notify'

describe('siteTransitionMessages', () => {
  it('builds admin and announce texts', () => {
    expect(siteTransitionMessages('main', 'ok', 'degraded')).toEqual({
      admin: 'площадка main: ok → degraded (туннель до REMOTE не отвечает, работает только домашний трафик)',
      announce: 'Зарубежные сайты сейчас недоступны, остальное работает. Уже чиним.',
    })
    expect(siteTransitionMessages('main', 'ok', 'down').announce).toBe('VPN сейчас недоступен. Уже чиним.')
    expect(siteTransitionMessages('main', 'down', 'ok').announce).toBe('VPN снова работает полностью.')
    expect(siteTransitionMessages('main', 'ok', 'down', 'LOCAL: x').admin).toContain('\nLOCAL: x')
  })
})

describe('notifyTransition', () => {
  const ctx = (announceOutages: boolean) => ({
    alert: vi.fn(async () => {}),
    config: () => ({ telegram: { announceOutages } }),
  }) as unknown as AppContext & { alert: ReturnType<typeof vi.fn> }

  it('alerts admins and announces to the chat', async () => {
    const c = ctx(true)
    await notifyTransition(c, 'main', 'ok', 'down')
    expect(c.alert.mock.calls).toEqual([
      [expect.stringContaining('площадка main: ok → down')],
      ['VPN сейчас недоступен. Уже чиним.', { announce: true }],
    ])
  })

  it('skips the chat when announceOutages is off', async () => {
    const c = ctx(false)
    await notifyTransition(c, 'main', 'degraded', 'ok')
    expect(c.alert).toHaveBeenCalledTimes(1)
  })
})
