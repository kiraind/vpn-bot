import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { utils } from 'ssh2'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { restoreBackup, type RestoreTargets } from './restore'

let dir: string
let targets: RestoreTargets
const key = utils.generateKeyPairSync('ed25519', { comment: 'vpn-coordinator' })

function makeTar(files: Record<string, string | Buffer>): string {
  const src = fs.mkdtempSync(path.join(dir, 'src-'))
  for(const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true })
    fs.writeFileSync(path.join(src, rel), content)
  }
  const tar = path.join(dir, `${path.basename(src)}.tar`)
  execFileSync('tar', ['-C', src, '-cf', tar, ...Object.keys(files)])
  return tar
}

function dbBytes(): Buffer {
  const file = path.join(dir, 'snapshot.db')
  const db = openDb(file)
  db.prepare(`INSERT INTO users (tg_id, username, created_at) VALUES (7, 'bob', '2026-01-01')`).run()
  db.pragma('wal_checkpoint(TRUNCATE)')
  db.close()
  return fs.readFileSync(file)
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-test-'))
  targets = {
    dbPath: path.join(dir, 'var', 'state.db'),
    configPath: path.join(dir, 'etc', 'config.yaml'),
    sshKeyDir: path.join(dir, 'var', 'ssh'),
  }
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('restoreBackup', () => {
  it('installs db, config and ssh key with tight permissions', async () => {
    const tar = makeTar({
      'state.db': dbBytes(),
      'config.yaml': 'telegram: {}\n',
      'ssh/id_ed25519': key.private,
      'ssh/id_ed25519.pub': `${key.public}\n`,
    })

    const done = await restoreBackup(tar, targets)
    expect(done.length).toBeGreaterThan(0)

    const mode = (p: string) => fs.statSync(p).mode & 0o777
    expect(mode(targets.configPath)).toBe(0o600)
    expect(mode(targets.sshKeyDir)).toBe(0o700)
    expect(mode(path.join(targets.sshKeyDir, 'id_ed25519'))).toBe(0o600)
    expect(fs.readFileSync(path.join(targets.sshKeyDir, 'id_ed25519'), 'utf8')).toBe(key.private)
    expect(fs.readFileSync(targets.configPath, 'utf8')).toBe('telegram: {}\n')

    const db = openDb(targets.dbPath)
    expect(db.prepare('SELECT username FROM users WHERE tg_id = 7').get()).toEqual({ username: 'bob' })
    db.close()
  })

  it('refuses to overwrite existing files without force, overwrites with it', async () => {
    const tar = makeTar({ 'state.db': dbBytes(), 'config.yaml': 'new\n', 'ssh/id_ed25519': key.private })
    fs.mkdirSync(path.dirname(targets.configPath), { recursive: true })
    fs.writeFileSync(targets.configPath, 'old\n')

    await expect(restoreBackup(tar, targets)).rejects.toThrow(/refusing to overwrite.*config\.yaml/)
    expect(fs.readFileSync(targets.configPath, 'utf8')).toBe('old\n')
    expect(fs.existsSync(targets.dbPath)).toBe(false)

    fs.mkdirSync(path.dirname(targets.dbPath), { recursive: true })
    fs.writeFileSync(`${targets.dbPath}-wal`, 'stale')
    await restoreBackup(tar, targets, { force: true })
    expect(fs.readFileSync(targets.configPath, 'utf8')).toBe('new\n')
    expect(fs.existsSync(`${targets.dbPath}-wal`)).toBe(false)
  })

  it('derives the public key when the backup has none', async () => {
    const tar = makeTar({ 'state.db': dbBytes(), 'config.yaml': 'x\n', 'ssh/id_ed25519': key.private })
    await restoreBackup(tar, targets)
    const pub = fs.readFileSync(path.join(targets.sshKeyDir, 'id_ed25519.pub'), 'utf8')
    expect(pub.split(' ').slice(0, 2)).toEqual(key.public.split(' ').slice(0, 2))
  })

  it('rejects an incomplete backup', async () => {
    const tar = makeTar({ 'state.db': 'x', 'config.yaml': 'x' })
    await expect(restoreBackup(tar, targets)).rejects.toThrow(/missing: ssh\/id_ed25519/)
    expect(fs.existsSync(targets.dbPath)).toBe(false)
  })
})
