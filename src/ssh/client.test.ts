import { execFileSync } from 'child_process'
import { describe, expect, it } from 'vitest'
import { HostKeyMismatchError, SshAuthError, SshTimeoutError, shellQuote, waitForSsh, wrapCommand } from './client'
import type { ConnectOptions, SshSession } from './client'

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
    expect(wrapCommand('echo hi', 'root', 'pw')).toEqual({ command: `bash -c 'echo hi'`, stdinPrefix: '' })
  })

  it('wraps non-root commands in sudo -S and feeds the password first', () => {
    expect(wrapCommand(`echo 'x'`, 'ubuntu', 's3cret')).toEqual({
      command: `sudo -S -k -p '' bash -c 'echo '\\''x'\\'''`,
      stdinPrefix: 's3cret\n',
    })
  })

  it('uses non-interactive sudo when there is no password', () => {
    expect(wrapCommand('true', 'ubuntu')).toEqual({ command: `sudo -n bash -c 'true'`, stdinPrefix: '' })
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
