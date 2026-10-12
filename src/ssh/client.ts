import { AnyAuthMethod, AuthenticationType, Client, ClientChannel } from 'ssh2'
import { Db } from '../db'
import { checkHostKey, hostKeyFingerprint } from './knownHosts'

// Error messages carry the runbook strings verbatim so alerts can be grepped/matched.
export class HostKeyMismatchError extends Error {
  constructor(public address: string, public fingerprint: string) {
    super(`host key mismatch for ${address} (got ${fingerprint}); confirm with /trust <node>`)
    this.name = 'HostKeyMismatchError'
  }
}

export class SshAuthError extends Error {
  constructor(public address: string, detail: string) {
    super(`ssh auth failed for ${address}: ${detail}`)
    this.name = 'SshAuthError'
  }
}

export class SshTimeoutError extends Error {
  constructor(public address: string, detail: string) {
    super(`ssh timeout for ${address}: ${detail}`)
    this.name = 'SshTimeoutError'
  }
}

export interface ConnectOptions {
  host: string
  port?: number
  user: string
  password?: string
  privateKey?: string
  db: Db
  timeoutMs?: number
}

export interface ExecOptions {
  stdin?: Buffer | string
  timeoutMs?: number
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export interface SshSession {
  usedAuth: 'key' | 'password'
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>
  run(command: string, opts?: ExecOptions): Promise<ExecResult>
  close(): void
}

const DEFAULT_CONNECT_TIMEOUT_MS = 20_000
const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60_000

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

// R-C3: non-root users go through sudo with the same password, fed as the first stdin line.
// `-k` forces sudo to actually read that line even when a cached timestamp exists, otherwise
// it would leak into the command's stdin. (A NOPASSWD sudoers entry would leak it too.)
// Without a password we can only hope for NOPASSWD, so `-n` fails fast instead of hanging.
export function wrapCommand(cmd: string, user: string, password?: string): { command: string, stdinPrefix: string } {
  const inner = `bash -c ${shellQuote(cmd)}`

  if(user === 'root') {
    return { command: inner, stdinPrefix: '' }
  }

  if(password === undefined) {
    return { command: `sudo -n ${inner}`, stdinPrefix: '' }
  }

  return { command: `sudo -S -k -p '' ${inner}`, stdinPrefix: `${password}\n` }
}

function tail(text: string, lines = 20): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n').slice(-2000)
}

export function connectSsh(opts: ConnectOptions): Promise<SshSession> {
  const address = opts.host
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const conn = new Client()

  // Key first (it is the steady state after bootstrap), password as fallback (first contact).
  const methods: AnyAuthMethod[] = []
  if(opts.privateKey) {
    methods.push({ type: 'publickey', username: opts.user, key: opts.privateKey })
  }
  if(opts.password !== undefined) {
    methods.push({ type: 'password', username: opts.user, password: opts.password })
  }

  let lastTried: AnyAuthMethod | undefined
  let mismatch: HostKeyMismatchError | undefined

  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (err: Error) => {
      if(settled) return
      settled = true
      conn.end()
      reject(err)
    }

    conn.on('ready', () => {
      if(settled) return
      settled = true
      resolve(makeSession(conn, opts, lastTried?.type === 'publickey' ? 'key' : 'password'))
    })

    conn.on('error', (err: Error & { level?: string }) => {
      if(mismatch) return fail(mismatch)
      if(err.level === 'client-authentication') return fail(new SshAuthError(address, err.message))
      if(err.level === 'client-timeout') return fail(new SshTimeoutError(address, err.message))
      fail(err)
    })

    conn.on('close', () => fail(mismatch ?? new Error(`ssh connection to ${address} closed before ready`)))

    if(methods.length === 0) {
      return fail(new SshAuthError(address, 'no private key or password configured'))
    }

    conn.connect({
      host: opts.host,
      port: opts.port ?? 22,
      username: opts.user,
      readyTimeout: timeoutMs,
      keepaliveInterval: 15_000,
      hostVerifier: (key: Buffer) => {
        const fingerprint = hostKeyFingerprint(key)
        if(checkHostKey(opts.db, address, fingerprint) === 'mismatch') {
          mismatch = new HostKeyMismatchError(address, fingerprint)
          return false
        }
        return true
      },
      authHandler: (_left: AuthenticationType[], _partial: boolean, next: (m: AnyAuthMethod | false) => void) => {
        lastTried = methods.shift()
        next(lastTried ?? false)
      },
    } as Parameters<Client['connect']>[0])
  })
}

function makeSession(conn: Client, opts: ConnectOptions, usedAuth: 'key' | 'password'): SshSession {
  const exec = (command: string, execOpts: ExecOptions = {}): Promise<ExecResult> => {
    const { command: wrapped, stdinPrefix } = wrapCommand(command, opts.user, opts.password)
    const timeoutMs = execOpts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS

    return new Promise((resolve, reject) => {
      conn.exec(wrapped, (err, stream: ClientChannel) => {
        if(err) return reject(err)

        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        let done = false

        const timer = setTimeout(() => {
          if(done) return
          done = true
          stream.close()
          reject(new SshTimeoutError(opts.host, `command exceeded ${timeoutMs}ms: ${command.slice(0, 80)}`))
        }, timeoutMs)

        stream.on('data', (chunk: Buffer) => stdout.push(chunk))
        stream.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
        stream.on('close', (code: number | null) => {
          if(done) return
          done = true
          clearTimeout(timer)
          resolve({
            // null means killed by a signal; report it as a failure, not success
            code: code ?? 255,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
          })
        })

        if(stdinPrefix) stream.write(stdinPrefix)
        if(execOpts.stdin !== undefined) stream.write(execOpts.stdin)
        stream.end()
      })
    })
  }

  return {
    usedAuth,
    exec,
    async run(command, execOpts) {
      const result = await exec(command, execOpts)
      if(result.code !== 0) {
        throw new Error(`command failed on ${opts.host} (exit ${result.code}): ${command.slice(0, 80)}\n${tail(result.stderr || result.stdout)}`)
      }
      return result
    },
    close() {
      conn.end()
    },
  }
}

export interface WaitOptions {
  totalMs?: number
  intervalMs?: number
  connect?: (opts: ConnectOptions) => Promise<SshSession>
  sleep?: (ms: number) => Promise<void>
  nowMs?: () => number
}

// Used after a reboot: keep retrying until sshd is back. A host key mismatch is permanent,
// so it is surfaced immediately instead of being retried for minutes.
export async function waitForSsh(opts: ConnectOptions, wait: WaitOptions = {}): Promise<SshSession> {
  const totalMs = wait.totalMs ?? 5 * 60_000
  const intervalMs = wait.intervalMs ?? 5_000
  const connect = wait.connect ?? connectSsh
  const sleep = wait.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const nowMs = wait.nowMs ?? Date.now
  const deadline = nowMs() + totalMs

  for(;;) {
    try {
      return await connect(opts)
    } catch(err) {
      if(err instanceof HostKeyMismatchError) throw err
      if(nowMs() + intervalMs >= deadline) {
        throw new SshTimeoutError(opts.host, `not reachable within ${totalMs}ms: ${(err as Error).message}`)
      }
    }
    await sleep(intervalMs)
  }
}
