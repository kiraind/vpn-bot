import { describe, expect, it } from 'vitest'
import type { ConnectOptions, ExecOptions, ExecResult, SshSession } from '../ssh/client'
import { SshAuthError } from '../ssh/client'
import type { Db } from '../db'
import { PROBE_COMMAND, probeNode, provisionNode } from './node'
import type { NodeTarget, ProvisionDeps, ProvisionPhase } from './node'
import { applyCommand, readMarkerCommand } from './scripts'

const PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ1bG7rQ8Yq6xYzVg0Wl7s9b2b2b2b2b2b2b2b2b2b2b vpn-coordinator'

type Responder = (cmd: string, opts?: ExecOptions) => Partial<ExecResult> | Error | undefined

interface Call { session: number, cmd: string, stdin?: string }

// A scripted SSH world: each connect hands out the next session spec; every exec is recorded.
function world(specs: Array<{ usedAuth?: 'key' | 'password', respond?: Responder } | Error>) {
  const calls: Call[] = []
  const connects: ConnectOptions[] = []
  const closed: number[] = []
  let next = 0

  const open = async (opts: ConnectOptions): Promise<SshSession> => {
    connects.push(opts)
    const id = next++
    const spec = specs[id]
    if(!spec) throw new Error(`unexpected connect #${id}`)
    if(spec instanceof Error) throw spec
    const exec = async (cmd: string, execOpts?: ExecOptions): Promise<ExecResult> => {
      const stdin = execOpts?.stdin
      calls.push({ session: id, cmd, stdin: typeof stdin === 'string' ? stdin : stdin?.toString('latin1') })
      if(cmd.includes('boot_id')) return { code: 0, stdout: `boot-${id}\n`, stderr: '' }
      const r = spec.respond?.(cmd, execOpts)
      if(r instanceof Error) throw r
      return { code: 0, stdout: '', stderr: '', ...r }
    }
    return {
      usedAuth: spec.usedAuth ?? 'key',
      exec,
      async run(cmd, execOpts) {
        const r = await exec(cmd, execOpts)
        if(r.code !== 0) throw new Error(`command failed (exit ${r.code}): ${r.stderr}`)
        return r
      },
      close() { closed.push(id) },
    }
  }

  return { calls, connects, closed, connect: open, waitForSsh: (opts: ConnectOptions) => open(opts) }
}

const target: NodeTarget = {
  node: 'main/remote',
  role: 'remote',
  host: '203.0.113.10',
  ssh: { user: 'root', password: 'pw', port: 2222 },
  addresses: ['203.0.113.10'],
  interfaces: ['awgt'],
  files: [{ path: '/etc/amnezia/amneziawg/awgt.conf', mode: 0o600, content: '[Interface]\n' }],
  hash: 'h-new',
}

function deps(w: ReturnType<typeof world>, phases: ProvisionPhase[] = []): ProvisionDeps {
  return {
    db: {} as Db,
    key: { privateKey: 'PRIV', publicKey: PUBLIC_KEY },
    coordinatorVersion: '2.0.0',
    connect: w.connect as ProvisionDeps['connect'],
    waitForSsh: w.waitForSsh as ProvisionDeps['waitForSsh'],
    onPhase: p => phases.push(p),
  }
}

const marker = (node: string, hash: string) => JSON.stringify({ node, appliedHash: hash })

// Responder for a configured node: marker present; bootstrap/apply behaviour pluggable.
function node(opts: { marker?: string, bootstrap?: Partial<ExecResult>, apply?: Partial<ExecResult> } = {}): Responder {
  return cmd => {
    if(cmd === readMarkerCommand()) return { stdout: opts.marker ?? '{}' }
    if(cmd === 'bash -s') return opts.bootstrap ?? { stdout: 'BOOTSTRAP_OK\n' }
    if(cmd === applyCommand()) return opts.apply ?? { stdout: `APPLIED ${target.hash}\n` }
    return undefined
  }
}

describe('provisionNode', () => {
  it('first contact: installs key, verifies key login, disables passwords, bootstraps, applies', async () => {
    const w = world([
      { usedAuth: 'password', respond: () => ({ stdout: 'KEY_INSTALLED\n' }) },
      { usedAuth: 'key', respond: node() },
    ])
    const phases: ProvisionPhase[] = []
    const res = await provisionNode(deps(w, phases), target)

    expect(res).toEqual({ outcome: 'applied', bootstrapped: true })
    expect(phases).toEqual(['connecting', 'bootstrapping', 'applying'])
    expect(w.connects[0]).toMatchObject({ host: target.host, port: 2222, user: 'root', privateKey: 'PRIV', password: 'pw' })

    const scripts = w.calls.filter(c => c.cmd === 'bash -s').map(c => [c.session, c.stdin ?? ''] as const)
    expect(scripts[0][0]).toBe(0)
    expect(scripts[0][1]).toContain(PUBLIC_KEY)
    expect(scripts[0][1]).toContain(`home='/root'`)
    expect(scripts[1][0]).toBe(1)
    expect(scripts[1][1]).toContain('PasswordAuthentication no')
    expect(scripts[2][1]).toContain('amneziawg')
    expect(w.calls.find(c => c.cmd === applyCommand())?.session).toBe(1)
    expect([...new Set(w.closed)].sort()).toEqual([0, 1])
  })

  it('looks up the home dir of a non-root user', async () => {
    const w = world([
      { usedAuth: 'password', respond: cmd => cmd.startsWith('getent') ? { stdout: '/home/ubuntu\n' } : undefined },
      { usedAuth: 'key', respond: node({ marker: marker(target.node, target.hash) }) },
    ])
    await provisionNode(deps(w), { ...target, ssh: { ...target.ssh, user: 'ubuntu' } })
    expect(w.calls[0].cmd).toBe(`getent passwd 'ubuntu' | cut -d: -f6`)
    expect(w.calls[1].stdin).toContain(`home='/home/ubuntu'`)
  })

  it('keeps passwords enabled when the key login does not work', async () => {
    const w = world([
      { usedAuth: 'password' },
      { usedAuth: 'password' },
    ])
    await expect(provisionNode(deps(w), target)).rejects.toThrow(/key login does not work/)
    expect(w.calls.some(c => c.stdin?.includes('PasswordAuthentication no'))).toBe(false)
    expect([...new Set(w.closed)].sort()).toEqual([0, 1])
  })

  it('propagates an auth failure on the verification connect without disabling passwords', async () => {
    const w = world([{ usedAuth: 'password' }, new SshAuthError(target.host, 'denied')])
    await expect(provisionNode(deps(w), target)).rejects.toBeInstanceOf(SshAuthError)
    expect(w.calls.some(c => c.stdin?.includes('PasswordAuthentication no'))).toBe(false)
    expect(w.closed).toEqual([0])
  })

  it('is up-to-date when marker matches', async () => {
    const w = world([{ respond: node({ marker: marker(target.node, target.hash) }) }])
    const phases: ProvisionPhase[] = []
    expect(await provisionNode(deps(w, phases), target)).toEqual({ outcome: 'up-to-date', bootstrapped: false })
    expect(phases).toEqual(['connecting'])
    expect(w.calls.map(c => c.cmd)).toEqual([readMarkerCommand()])
    expect(w.closed).toEqual([0])
  })

  it('applies (without bootstrap) when the hash differs, streaming the bundle', async () => {
    const w = world([{ respond: node({ marker: marker(target.node, 'h-old') }) }])
    const phases: ProvisionPhase[] = []
    expect(await provisionNode(deps(w, phases), target)).toEqual({ outcome: 'applied', bootstrapped: false })
    expect(phases).toEqual(['connecting', 'applying'])
    const apply = w.calls.find(c => c.cmd === applyCommand())
    expect(apply?.stdin).toContain('files/etc/amnezia/amneziawg/awgt.conf')
    expect(apply?.stdin).toContain(`HASH='h-new'`)
    expect(apply?.stdin).toContain(`COORDINATOR_VERSION='2.0.0'`)
  })

  it('bootstraps when the marker belongs to another node, or on force/upgrade', async () => {
    for(const [m, opts] of [
      [marker('other/remote', target.hash), {}],
      [marker(target.node, target.hash), { force: true }],
      [marker(target.node, target.hash), { upgrade: true }],
      ['garbage', {}],
    ] as const) {
      const w = world([{ respond: node({ marker: m }) }])
      expect(await provisionNode(deps(w), target, opts)).toEqual({ outcome: 'applied', bootstrapped: true })
    }
  })

  it('reboots when bootstrap asks for it and continues on the new session', async () => {
    let runs = 0
    const first: Responder = cmd => {
      if(cmd === 'bash -s') {
        runs++
        return { code: 100, stdout: 'REBOOT_REQUIRED\n' }
      }
      if(cmd === 'systemctl reboot') return new Error('connection lost')
      return node()(cmd)
    }
    const w = world([{ respond: first }, { respond: node() }])
    const phases: ProvisionPhase[] = []
    expect(await provisionNode(deps(w, phases), target)).toEqual({ outcome: 'applied', bootstrapped: true })
    expect(runs).toBe(1)
    expect(phases).toEqual(['connecting', 'bootstrapping', 'rebooting', 'bootstrapping', 'applying'])
    expect(w.calls.find(c => c.cmd === applyCommand())?.session).toBe(1)
    expect([...new Set(w.closed)].sort()).toEqual([0, 1])
  })

  it('gives up after two reboots with a module build failure', async () => {
    const always: Responder = cmd => cmd === 'bash -s' ? { code: 100, stdout: 'REBOOT_REQUIRED\n' } : node()(cmd)
    const w = world([{ respond: always }, { respond: always }, { respond: always }])
    await expect(provisionNode(deps(w), target)).rejects.toThrow('amneziawg module build failed')
    expect(w.calls.filter(c => c.cmd === 'systemctl reboot')).toHaveLength(2)
    expect([...new Set(w.closed)].sort()).toEqual([0, 1, 2])
  })

  it('maps bootstrap exit codes to runbook errors', async () => {
    const cases: Array<[Partial<ExecResult>, RegExp]> = [
      [{ code: 10, stderr: 'unsupported os\n' }, /^unsupported os$/],
      [{ code: 11, stderr: 'x' }, /^amneziawg module build failed$/],
      [{ code: 1, stderr: 'line1\nE: apt broke\n' }, /bootstrap failed \(exit 1\): [\s\S]*E: apt broke/],
      // A stdin-reading child swallowed the rest of the script: exit 0 but no marker.
      [{ code: 0, stdout: 'Reading package lists...\n' }, /^bootstrap failed: script ended early$/],
    ]
    for(const [bootstrap, re] of cases) {
      const w = world([{ respond: node({ bootstrap }) }])
      await expect(provisionNode(deps(w), target)).rejects.toThrow(re)
      expect(w.closed).toEqual([0])
    }
  })

  it('maps apply failures', async () => {
    const missing = world([{ respond: node({ marker: marker(target.node, 'old'), apply: { code: 20, stderr: 'address 203.0.113.10 not present on host\n' } }) }])
    await expect(provisionNode(deps(missing), target)).rejects.toThrow(/^address 203\.0\.113\.10 not present on host$/)

    const failed = world([{ respond: node({ marker: marker(target.node, 'old'), apply: { code: 31, stderr: 'awg-quick@awgt failed to start\n' } }) }])
    await expect(provisionNode(deps(failed), target)).rejects.toThrow('apply failed (exit 31): awg-quick@awgt failed to start')

    const unconfirmed = world([{ respond: node({ marker: marker(target.node, 'old'), apply: { stdout: 'APPLIED other\n' } }) }])
    await expect(provisionNode(deps(unconfirmed), target)).rejects.toThrow(/no APPLIED h-new/)
  })
})

describe('probeNode', () => {
  it('returns the parsed dump', async () => {
    const dump = 'awgt\tpriv\tpub\t51820\toff\nawgt\tpeer\t(none)\t1.2.3.4:51820\t10.0.0.0/24\t1700000000\t1\t2\toff\n'
    const w = world([{ respond: cmd => cmd === PROBE_COMMAND ? { stdout: dump + '__now__ 1700000100\n' } : undefined }])
    const probe = await probeNode(deps(w), target)
    expect(probe.reachable).toBe(true)
    expect(probe.dump?.interfaces.awgt.peers[0].latestHandshake).toBe(1700000000)
    expect(Object.keys(probe.dump!.interfaces)).toEqual(['awgt'])
    expect(probe.nowSec).toBe(1700000100)
    expect(w.closed).toEqual([0])
  })

  it('reports unreachable on connect or command errors without throwing', async () => {
    const down = world([new Error('ssh timeout for 203.0.113.10: x')])
    expect(await probeNode(deps(down), target)).toEqual({ reachable: false, error: 'ssh timeout for 203.0.113.10: x' })

    const broken = world([{ respond: () => ({ code: 1, stderr: 'awg: not found' }) }])
    const probe = await probeNode(deps(broken), target)
    expect(probe.reachable).toBe(false)
    expect(probe.error).toContain('awg: not found')
    expect(broken.closed).toEqual([0])
  })

  it('leaves nowSec unset when the clock line is missing', async () => {
    const w = world([{ respond: () => ({ stdout: 'awgt\tpriv\tpub\t51820\toff\n' }) }])
    const probe = await probeNode(deps(w), target)
    expect(probe.reachable).toBe(true)
    expect(probe.nowSec).toBeUndefined()
  })
})
