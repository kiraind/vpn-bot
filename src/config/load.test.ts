import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigWatcher, loadConfigFile, parseConfigText } from './load'

const exampleText = fs.readFileSync(path.join(__dirname, '../../examples/config.example.yaml'), 'utf8')
const env = {
  TELEGRAM_BOT_TOKEN: '123:abc',
  MAIN_LOCAL_PASSWORD: 'p#ss: {weird}',
  MAIN_REMOTE_PASSWORD: 'remote-pass',
}

describe('parseConfigText', () => {
  it('parses the example config with defaults applied', () => {
    const result = parseConfigText(exampleText, env)
    if(!result.ok) throw new Error(result.errors.join('\n'))
    const { config } = result
    expect(config.telegram.chatId).toBe(-1001234567890)
    expect(config.telegram.botToken).toBe('123:abc')
    expect(config.clients.dns).toEqual(['1.1.1.1', '8.8.8.8'])
    expect(config.tunnel).toEqual({ subnet: '10.255.0.0/30', mtu: 1380, protocol: 'awg3' })
    expect(config.sites[0].local.ssh).toEqual({ user: 'root', password: 'p#ss: {weird}', port: 22 })
    expect(config.sites[0].remote.ssh).toEqual({ user: 'root', password: 'remote-pass', port: 22 })
    expect(config.sites[0].local.addresses.client).toBe('203.0.113.10')
  })

  it('expands env references inside larger strings and strips address prefixes', () => {
    const text = exampleText
      .replace('https://vpn.example.com', 'https://${HOST}/v2')
      .replace('client: 203.0.113.10', 'client: 203.0.113.10/24')
    const result = parseConfigText(text, { ...env, HOST: 'vpn.test' })
    if(!result.ok) throw new Error(result.errors.join('\n'))
    expect(result.config.api.publicUrl).toBe('https://vpn.test/v2')
    expect(result.config.sites[0].local.addresses.client).toBe('203.0.113.10')
  })

  it('reports missing env vars with their location', () => {
    const result = parseConfigText(exampleText, { TELEGRAM_BOT_TOKEN: 'x' })
    expect(result).toEqual({
      ok: false,
      errors: [
        'sites.0.local.ssh.password: environment variable MAIN_LOCAL_PASSWORD is not set',
        'sites.0.remote.ssh.password: environment variable MAIN_REMOTE_PASSWORD is not set',
      ],
    })
  })

  it('reports schema errors as readable path lines', () => {
    const text = exampleText
      .replace('client: 203.0.113.10', 'client: not-an-ip')
      .replace('country: RU', 'country: ru')
      .replace('chatId: -1001234567890', 'chatId: 1001234567890')
    const result = parseConfigText(text, env)
    expect(result.ok).toBe(false)
    if(result.ok) return
    expect(result.errors).toContain('sites.0.local.addresses.client: expected an IPv4 address, optionally with /prefix')
    expect(result.errors).toContain('sites.0.local.country: expected ISO 3166-1 alpha-2 country code')
    expect(result.errors).toContain('telegram.chatId: expected a group chat id (negative, e.g. -1001234567890); positive ids are users')
  })

  it('reports YAML syntax errors and empty documents', () => {
    const broken = parseConfigText('telegram: [unclosed', env)
    expect(broken.ok).toBe(false)
    if(!broken.ok) expect(broken.errors[0]).toMatch(/^yaml: /)
    const empty = parseConfigText('', env)
    expect(empty.ok).toBe(false)
  })

  it('reports unreadable files', () => {
    const result = loadConfigFile('/nonexistent/config.yaml', env)
    expect(result.ok).toBe(false)
    if(!result.ok) expect(result.errors[0]).toMatch(/^cannot read \/nonexistent\/config.yaml/)
  })
})

describe('ConfigWatcher', () => {
  let dir: string | undefined
  afterEach(() => {
    if(dir) fs.rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('emits change only on real changes and keeps the last valid config on invalid reload', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-coord-config-'))
    const file = path.join(dir, 'config.yaml')
    fs.writeFileSync(file, exampleText)
    const watcher = new ConfigWatcher(file, { env })
    const changes: unknown[] = []
    const invalid: string[][] = []
    watcher.on('change', config => changes.push(config))
    watcher.on('invalid', errors => invalid.push(errors))

    expect(watcher.reload().ok).toBe(true)
    expect(changes).toHaveLength(1)
    const first = watcher.config

    // whitespace/comment-only edit: same parsed config, no event
    fs.writeFileSync(file, `# edited\n${exampleText}`)
    watcher.reload()
    expect(changes).toHaveLength(1)

    fs.writeFileSync(file, exampleText.replace('mtu: 1280', 'mtu: 99999'))
    expect(watcher.reload().ok).toBe(false)
    expect(invalid).toEqual([['clients.mtu: Too big: expected number to be <=1500']])
    expect(watcher.config).toBe(first)

    fs.writeFileSync(file, exampleText.replace('mtu: 1280', 'mtu: 1300'))
    watcher.reload()
    expect(changes).toHaveLength(2)
    expect(watcher.config?.clients.mtu).toBe(1300)
  })

  it('picks up file changes via polling', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-coord-config-'))
    const file = path.join(dir, 'config.yaml')
    fs.writeFileSync(file, exampleText)
    const watcher = new ConfigWatcher(file, { env, intervalMs: 20 })
    watcher.reload()
    const changed = new Promise(resolve => watcher.once('change', resolve))
    watcher.start()
    try {
      // fs.watchFile takes its baseline stat asynchronously; a change made before that is invisible to it
      await new Promise(resolve => setTimeout(resolve, 200))
      // rename-on-save, like many editors do
      const tmp = path.join(dir, 'config.yaml.tmp')
      fs.writeFileSync(tmp, exampleText.replace('mtu: 1280', 'mtu: 1400'))
      fs.renameSync(tmp, file)
      await changed
      expect(watcher.config?.clients.mtu).toBe(1400)
    } finally {
      watcher.stop()
    }
  })
})
