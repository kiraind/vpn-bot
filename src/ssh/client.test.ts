import { execFileSync } from 'child_process'
import { describe, expect, it } from 'vitest'
import { HostKeyMismatchError, SshAuthError, SshTimeoutError, createSession, probeNopasswd, scrubSecret, shellQuote, waitForSsh, wrapCommand } from './client'
import type { ConnectOptions, ExecResult, RawExec, SshSession } from './client'

describe('shellQuote', () => {
  it('round-trips through bash', () => {
    for(const value of ['plain', "it's", 'a "b" $HOME `x` \\n', '', "''", 'multi\nline']) {
      const out = execFileSync('bash', ['-c', `printf %s ${shellQuote(value)}`]).toString()
      expect(out).toBe(value)
    }
  })
})

describe('wrapCommand', () => {
  it('runs root commands directly through bash', () => {
    expect(wrapCommand('echo hi', 'root', 'pw', false)).toEqual({ command: `bash -c 'echo hi'`, stdinPrefix: '' })
  })

  it('wraps non-root commands in sudo -S and feeds the password first', () => {
    expect(wrapCommand(`echo 'x'`, 'ubuntu', 's3cret', false)).toEqual({
      command: `sudo -S -k -p '' bash -c 'echo '\\''x'\\'''`,
      stdinPrefix: 's3cret\n',
    })
  })

  it('does not feed the password when sudo is NOPASSWD', () => {
    expect(wrapCommand('true', 'ubuntu', 's3cret', true)).toEqual({ command: `sudo -n bash -c 'true'`, stdinPrefix: '' })
  })

  it('uses non-interactive sudo when there is no password', () => {
    expect(wrapCommand('true', 'ubuntu', undefined, false)).toEqual({ command: `sudo -n bash -c 'true'`, stdinPrefix: '' })
  })
})

describe('scrubSecret', () => {
  it('masks every occurrence', () => {
    expect(scrubSecret('pw: s3cret; again s3cret', 's3cret')).toBe('pw: ***; again ***')
  })

  it('is a no-op without a secret', () => {
    expect(scrubSecret('text', undefined)).toBe('text')
    expect(scrubSecret('text', '')).toBe('text')
  })
})

interface Call { command: string, stdin: string }

function fakeRaw(probeCode: number | Error, result: ExecResult = { code: 0, stdout: '', stderr: '' }) {
  const calls: Call[] = []
  const raw: RawExec = async (command, stdin) => {
    calls.push({ command, stdin: stdin.map(String).join('') })
    if(command === 'sudo -n true') {
      if(probeCode instanceof Error) throw probeCode
      return { code: probeCode, stdout: '', stderr: probeCode ? 'sudo: a password is required' : '' }
    }
    return result
  }
  return { raw, calls }
}

describe('probeNopasswd', () => {
  it('is true only when sudo -n succeeds', async () => {
    expect(await probeNopasswd(fakeRaw(0).raw)).toBe(true)
    expect(await probeNopasswd(fakeRaw(1).raw)).toBe(false)
    expect(await probeNopasswd(fakeRaw(new Error('boom')).raw)).toBe(false)
  })
})

describe('createSession', () => {
  const opts = { host: 'h', user: 'ubuntu', password: 's3cret' }

  it('skips the password for NOPASSWD sudo', async () => {
    const { raw, calls } = fakeRaw(0)
    const session = await createSession(raw, opts, 'password', () => {})
    await session.exec('bash -s', { stdin: 'echo hi\n' })
    expect(calls).toEqual([
      { command: 'sudo -n true', stdin: '' },
      { command: `sudo -n bash -c 'bash -s'`, stdin: 'echo hi\n' },
    ])
  })

  it('feeds the password when sudo asks for it', async () => {
    const { raw, calls } = fakeRaw(1)
    const session = await createSession(raw, opts, 'password', () => {})
    await session.exec('bash -s', { stdin: 'echo hi\n' })
    expect(calls[1]).toEqual({ command: `sudo -S -k -p '' bash -c 'bash -s'`, stdin: 's3cret\necho hi\n' })
  })

  it('does not probe for root', async () => {
    const { raw, calls } = fakeRaw(0)
    const session = await createSession(raw, { ...opts, user: 'root' }, 'key', () => {})
    await session.exec('true')
    expect(calls).toEqual([{ command: `bash -c 'true'`, stdin: '' }])
  })

  it('scrubs the password from run errors', async () => {
    const { raw } = fakeRaw(1, { code: 127, stdout: '', stderr: 'bash: line 1: s3cret: command not found' })
    const session = await createSession(raw, opts, 'password', () => {})
    const err: Error = await session.run('bash -s').then(() => new Error('resolved'), (e: Error) => e)
    expect(err.message).not.toBe('resolved')
    expect(err.message).toContain('exit 127')
    expect(err.message).not.toContain('s3cret')
  })
})

describe('error messages', () => {
  it('contain the runbook strings', () => {
    expect(new HostKeyMismatchError('h', 'SHA256:x').message).toContain('host key mismatch')
    expect(new SshAuthError('h', 'd').message).toContain('ssh auth failed')
    expect(new SshTimeoutError('h', 'd').message).toContain('ssh timeout')
  })
})

describe('waitForSsh', () => {
  const opts = { host: 'h', user: 'root' } as ConnectOptions
  const session = { usedAuth: 'key' } as SshSession

  function clock() {
    let t = 0
    return { nowMs: () => t, sleep: async (ms: number) => { t += ms } }
  }

  it('retries until connect succeeds', async () => {
    let attempts = 0
    const connect = async () => {
      attempts += 1
      if(attempts < 3) throw new Error('ECONNREFUSED')
      return session
    }
    await expect(waitForSsh(opts, { connect, intervalMs: 1000, ...clock() })).resolves.toBe(session)
    expect(attempts).toBe(3)
  })

  it('gives up after totalMs with a timeout error', async () => {
    const connect = async (): Promise<SshSession> => { throw new Error('ECONNREFUSED') }
    await expect(waitForSsh(opts, { connect, totalMs: 10_000, intervalMs: 1000, ...clock() }))
      .rejects.toBeInstanceOf(SshTimeoutError)
  })

  it('does not retry a host key mismatch', async () => {
    let attempts = 0
    const connect = async (): Promise<SshSession> => {
      attempts += 1
      throw new HostKeyMismatchError('h', 'SHA256:x')
    }
    await expect(waitForSsh(opts, { connect, ...clock() })).rejects.toBeInstanceOf(HostKeyMismatchError)
    expect(attempts).toBe(1)
  })
})
