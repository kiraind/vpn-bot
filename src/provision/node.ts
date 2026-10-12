import type { NodeRole, RenderedFile } from '../types'
import type { SshConfig } from '../config/schema'
import type { Db } from '../db'
import type { CoordinatorKey } from '../ssh/keys'
import type { NodeProbe } from '../health/evaluate'
import { parseAwgDump } from '../health/dump'
import { connectSsh, shellQuote, waitForSsh } from '../ssh/client'
import type { ConnectOptions, ExecResult, SshSession } from '../ssh/client'
import {
  BOOTSTRAP_OK,
  EXIT_CODES,
  REBOOT_REQUIRED,
  applyCommand,
  bootstrapScript,
  buildApplyBundle,
  disablePasswordScript,
  installKeyScript,
  readMarkerCommand,
} from './scripts'

export interface NodeTarget {
  node: string
  role: NodeRole
  /** SSH goes to addresses.outer. */
  host: string
  ssh: SshConfig
  /** All addresses that must be present on the host (R-N3). */
  addresses: string[]
  interfaces: string[]
  files: RenderedFile[]
  hash: string
}

export type ProvisionPhase = 'connecting' | 'bootstrapping' | 'rebooting' | 'applying'

export interface ProvisionDeps {
  db: Db
  key: CoordinatorKey
  coordinatorVersion: string
  connect?: typeof connectSsh
  waitForSsh?: typeof waitForSsh
  onPhase?: (phase: ProvisionPhase) => void
  log?: (msg: string) => void
}

export interface ProvisionResult { outcome: 'applied' | 'up-to-date', bootstrapped: boolean }

interface Marker { node?: unknown, appliedHash?: unknown }

const MAX_REBOOTS = 2
const REBOOT_WAIT_MS = 5 * 60_000
const BOOT_ID_COMMAND = 'cat /proc/sys/kernel/random/boot_id'

function tail(text: string, lines = 10): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n').slice(-1500)
}

function connectOptions(deps: ProvisionDeps, target: Pick<NodeTarget, 'host' | 'ssh'>): ConnectOptions {
  return {
    host: target.host,
    port: target.ssh.port,
    user: target.ssh.user,
    privateKey: deps.key.privateKey,
    password: target.ssh.password,
    db: deps.db,
  }
}

function parseMarker(stdout: string): Marker {
  try {
    const parsed = JSON.parse(stdout.trim() || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function homeDirOf(session: SshSession, user: string): Promise<string> {
  if(user === 'root') return '/root'
  const res = await session.run(`getent passwd ${shellQuote(user)} | cut -d: -f6`)
  const home = res.stdout.trim()
  if(!home.startsWith('/')) throw new Error(`cannot determine home dir of ${user}`)
  return home
}

/**
 * First contact (spec 7.2 step 2, Q-C3): the session got in by password, so install our key,
 * prove a key login works in a fresh connection, and only then turn password logins off.
 * Returns the key-authenticated session, which replaces the password one.
 */
async function switchToKey(ctx: Ctx, session: SshSession): Promise<SshSession> {
  const { deps, target } = ctx
  const home = await homeDirOf(session, target.ssh.user)
  await session.run('bash -s', { stdin: installKeyScript(deps.key.publicKey, home) })
  ctx.log(`${target.node}: coordinator key installed`)

  // The password still goes along: non-root users need it for sudo. Key auth is tried first,
  // so usedAuth === 'key' proves the key login works.
  const verified = await ctx.connect()
  if(verified.usedAuth !== 'key') {
    throw new Error('ssh auth failed: key login does not work after installing the coordinator key; password login left enabled')
  }
  session.close()

  await verified.run('bash -s', { stdin: disablePasswordScript() })
  ctx.log(`${target.node}: password login disabled`)
  return verified
}

/** Runs bootstrap, rebooting (up to MAX_REBOOTS) when it asks for it. Returns the live session. */
async function bootstrap(ctx: Ctx, initial: SshSession): Promise<SshSession> {
  const { deps, target } = ctx
  let session = initial

  for(let reboots = 0; ; reboots++) {
    deps.onPhase?.('bootstrapping')
    const res: ExecResult = await session.exec('bash -s', { stdin: bootstrapScript() })

    if(res.code === 0) {
      // Exit 0 without the marker means bash stopped reading the script early (see wrapMain).
      const ok = res.stdout.split('\n').find(l => l.startsWith(BOOTSTRAP_OK))
      if(!ok) throw new Error('bootstrap failed: script ended early')
      ctx.log(`${target.node}: ${ok.trim()}`)
      return session
    }

    if(res.code === EXIT_CODES.rebootRequired || res.stdout.includes(REBOOT_REQUIRED)) {
      if(reboots >= MAX_REBOOTS) throw new Error('amneziawg module build failed')
      deps.onPhase?.('rebooting')
      ctx.log(`${target.node}: rebooting (${reboots + 1}/${MAX_REBOOTS})`)
      session = await reboot(ctx, session)
      continue
    }

    if(res.code === EXIT_CODES.unsupportedOs) throw new Error('unsupported os')
    if(res.code === EXIT_CODES.moduleBuildFailed) throw new Error('amneziawg module build failed')
    throw new Error(`bootstrap failed (exit ${res.code}): ${tail(res.stderr || res.stdout)}`)
  }
}

async function reboot(ctx: Ctx, session: SshSession): Promise<SshSession> {
  const before = (await session.exec(BOOT_ID_COMMAND).catch(() => undefined))?.stdout.trim()
  // The connection usually dies mid-command; whatever comes back is irrelevant.
  await session.exec('systemctl reboot').catch(() => undefined)
  session.close()

  // sshd may still answer for a moment after `systemctl reboot` returns; a reconnect to the
  // dying system is detected by an unchanged boot id and retried.
  const deadline = Date.now() + REBOOT_WAIT_MS
  for(;;) {
    const next = await ctx.waitForSsh()
    const after = (await next.exec(BOOT_ID_COMMAND).catch(() => undefined))?.stdout.trim()
    if(!before || !after || after !== before) return next
    next.close()
    if(Date.now() >= deadline) throw new Error(`ssh timeout for ${ctx.target.host}: node did not reboot`)
    await new Promise(r => setTimeout(r, 5_000))
  }
}

async function apply(ctx: Ctx, session: SshSession): Promise<void> {
  const { deps, target } = ctx
  deps.onPhase?.('applying')
  const bundle = buildApplyBundle(target.files, {
    node: target.node,
    role: target.role,
    hash: target.hash,
    coordinatorVersion: deps.coordinatorVersion,
    addresses: target.addresses,
    interfaces: target.interfaces,
  })
  const res = await session.exec(applyCommand(), { stdin: bundle })

  if(res.code === EXIT_CODES.addressMissing) {
    const line = res.stderr.split('\n').find(l => l.includes('not present on host'))
    throw new Error(line?.trim() || `apply failed (exit ${res.code}): ${tail(res.stderr)}`)
  }
  if(res.code !== 0) throw new Error(`apply failed (exit ${res.code}): ${tail(res.stderr || res.stdout)}`)
  if(!res.stdout.includes(`APPLIED ${target.hash}`)) {
    throw new Error(`apply failed: no APPLIED ${target.hash} confirmation: ${tail(res.stdout)}`)
  }
}

interface Ctx {
  deps: ProvisionDeps
  target: NodeTarget
  connect: () => Promise<SshSession>
  waitForSsh: () => Promise<SshSession>
  log: (msg: string) => void
}

/** One reconcile step for one node (spec 7.1 steps 2–3, 7.2, 7.3). Throws runbook-friendly errors (runbook 3.5). */
export async function provisionNode(deps: ProvisionDeps, target: NodeTarget, opts: { upgrade?: boolean, force?: boolean } = {}): Promise<ProvisionResult> {
  const connect = deps.connect ?? connectSsh
  const wait = deps.waitForSsh ?? waitForSsh
  // Every session ever opened is closed at the end; close() on an already closed one is a no-op.
  const opened: SshSession[] = []
  const track = (s: SshSession) => {
    opened.push(s)
    return s
  }
  const ctx: Ctx = {
    deps,
    target,
    connect: async () => track(await connect(connectOptions(deps, target))),
    waitForSsh: async () => track(await wait(connectOptions(deps, target), { totalMs: REBOOT_WAIT_MS, connect })),
    log: deps.log ?? (() => {}),
  }

  try {
    deps.onPhase?.('connecting')
    let session = await ctx.connect()
    if(session.usedAuth === 'password') session = await switchToKey(ctx, session)

    const marker = parseMarker((await session.run(readMarkerCommand())).stdout)
    let bootstrapped = false

    if(opts.force || opts.upgrade || marker.node !== target.node) {
      session = await bootstrap(ctx, session)
      bootstrapped = true
    }

    if(bootstrapped || marker.appliedHash !== target.hash) {
      await apply(ctx, session)
      return { outcome: 'applied', bootstrapped }
    }

    return { outcome: 'up-to-date', bootstrapped: false }
  } finally {
    for(const s of opened) s.close()
  }
}

/** Health probe (spec 8 R-H1). Never throws. */
export async function probeNode(deps: ProvisionDeps, target: Pick<NodeTarget, 'node' | 'host' | 'ssh'>): Promise<NodeProbe> {
  const connect = deps.connect ?? connectSsh
  let session: SshSession | undefined

  try {
    session = await connect(connectOptions(deps, target))
    const res = await session.run('awg show all dump')
    return { reachable: true, dump: parseAwgDump(res.stdout) }
  } catch(err) {
    return { reachable: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    session?.close()
  }
}
