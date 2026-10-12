import { describe, expect, it, vi } from 'vitest'
import { localInput, remoteInput } from './testFixtures'
import { desiredHash, renderLocal, renderRemote } from './index'

// Keep these tests about composition; nftables has its own tests.
vi.mock('./nftables', () => ({
  renderLocalNft: () => 'local-nft\n',
  renderRemoteNft: () => 'remote-nft\n',
}))

describe('renderLocal', () => {
  it('produces all LOCAL files with modes', () => {
    const files = renderLocal(localInput)
    expect(files.map(f => [f.path, f.mode])).toEqual([
      ['/etc/amnezia/amneziawg/awgc.conf', 0o600],
      ['/etc/amnezia/amneziawg/awgt.conf', 0o600],
      ['/etc/nftables.conf', 0o644],
      ['/etc/sysctl.d/90-vpn-node.conf', 0o644],
      ['/etc/vpn-node/routing.sh', 0o755],
      ['/etc/systemd/system/vpn-routing.service', 0o644],
    ])
    expect(files[2].content).toBe('local-nft\n')
  })
})

describe('renderRemote', () => {
  it('has no routing script or unit', () => {
    const files = renderRemote(remoteInput)
    expect(files.map(f => f.path)).toEqual([
      '/etc/amnezia/amneziawg/awgt.conf', '/etc/nftables.conf', '/etc/sysctl.d/90-vpn-node.conf',
    ])
    expect(files[1].content).toBe('remote-nft\n')
  })
})

describe('desiredHash', () => {
  const files = renderLocal(localInput)

  it('is sha256 hex and independent of file order', () => {
    const h = desiredHash(files, 'v1')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(desiredHash([...files].reverse(), 'v1')).toBe(h)
  })

  it('is stable across renders, including peer order', () => {
    const shuffled = { ...localInput, peers: [...localInput.peers].reverse() }
    expect(desiredHash(renderLocal(shuffled), 'v1')).toBe(desiredHash(files, 'v1'))
  })

  it('changes with content, mode, path and extra', () => {
    const h = desiredHash(files, 'v1')
    expect(desiredHash(files, 'v2')).not.toBe(h)
    expect(desiredHash(files.map((f, i) => i === 0 ? { ...f, mode: 0o644 } : f), 'v1')).not.toBe(h)
    expect(desiredHash(files.map((f, i) => i === 0 ? { ...f, content: f.content + '#' } : f), 'v1')).not.toBe(h)
    expect(desiredHash(files.map((f, i) => i === 0 ? { ...f, path: f.path + 'x' } : f), 'v1')).not.toBe(h)
    expect(desiredHash(renderLocal({ ...localInput, peers: localInput.peers.slice(1) }), 'v1')).not.toBe(h)
  })

  it('does not collide on shifted field boundaries', () => {
    const a = [{ path: '/a', mode: 0o600, content: 'bc' }]
    const b = [{ path: '/ab', mode: 0o600, content: 'c' }]
    expect(desiredHash(a, '')).not.toBe(desiredHash(b, ''))
  })
})
