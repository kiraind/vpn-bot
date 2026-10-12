import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db'
import { createBackup, defaultRun, type RunCommand } from './backup'

let dir: string
let db: Db

function hasBinary(name: string) {
  try {
    execFileSync('which', [name], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-test-'))
  db = openDb(path.join(dir, 'live.db'))
  db.prepare(`INSERT INTO users (tg_id, username, created_at) VALUES (42, 'alice', '2026-01-01')`).run()
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'telegram: {}\n')
  fs.mkdirSync(path.join(dir, 'ssh'))
  fs.writeFileSync(path.join(dir, 'ssh', 'id_ed25519'), 'PRIVATE\n')
  fs.writeFileSync(path.join(dir, 'ssh', 'id_ed25519.pub'), 'ssh-ed25519 AAAA\n')
  fs.writeFileSync(path.join(dir, 'backup.pub'), 'age1test\n')
})

afterEach(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

// Runs tar for real but replaces age encryption with a plain copy, recording the invocation.
function fakeRun(calls: { cmd: string, args: string[] }[]): RunCommand {
  return async (cmd, args, opts) => {
    calls.push({ cmd, args })
    if(cmd === 'age') {
      fs.copyFileSync(args[args.length - 1], args[args.indexOf('-o') + 1])
      return
    }
    await defaultRun(cmd, args, opts)
  }
}

describe('createBackup', () => {
  it('builds a tar with db, config and ssh key, encrypts it with age -R and cleans up', async () => {
    const calls: { cmd: string, args: string[] }[] = []
    const out = path.join(dir, 'out')
    const result = await createBackup({
      db,
      configPath: path.join(dir, 'config.yaml'),
      sshKeyDir: path.join(dir, 'ssh'),
      backupPubPath: path.join(dir, 'backup.pub'),
      workDir: out,
      date: new Date('2026-10-12T10:00:00Z'),
      run: fakeRun(calls),
    })

    expect(result.name).toBe('vpn-backup-2026-10-12.tar.age')
    expect(result.file).toBe(path.join(out, result.name))
    expect(fs.statSync(result.file).mode & 0o777).toBe(0o600)

    const age = calls.find(c => c.cmd === 'age')!
    expect(age.args.slice(0, 4)).toEqual(['-R', path.join(dir, 'backup.pub'), '-o', result.file])

    // Staging dir and the plaintext tar must be gone; only the encrypted output remains.
    expect(fs.readdirSync(out)).toEqual([result.name])

    const listing = execFileSync('tar', ['-tf', result.file], { encoding: 'utf8' }).trim().split('\n').sort()
    expect(listing).toEqual(['config.yaml', 'ssh/id_ed25519', 'ssh/id_ed25519.pub', 'state.db'])

    const extract = path.join(dir, 'extract')
    fs.mkdirSync(extract)
    execFileSync('tar', ['-C', extract, '-xf', result.file])
    expect(fs.readFileSync(path.join(extract, 'ssh', 'id_ed25519'), 'utf8')).toBe('PRIVATE\n')
    const copy = openDb(path.join(extract, 'state.db'))
    expect(copy.prepare('SELECT username FROM users WHERE tg_id = 42').get()).toEqual({ username: 'alice' })
    copy.close()
  })

  it('fails clearly when backup.pub is missing', async () => {
    await expect(createBackup({
      db,
      configPath: path.join(dir, 'config.yaml'),
      sshKeyDir: path.join(dir, 'ssh'),
      backupPubPath: path.join(dir, 'nope.pub'),
      workDir: path.join(dir, 'out'),
      run: async () => {},
    })).rejects.toThrow(/backup\.pub not found: .*nope\.pub/)
  })

  it('cleans the staging dir when encryption fails', async () => {
    const out = path.join(dir, 'out')
    await expect(createBackup({
      db,
      configPath: path.join(dir, 'config.yaml'),
      sshKeyDir: path.join(dir, 'ssh'),
      backupPubPath: path.join(dir, 'backup.pub'),
      workDir: out,
      run: async (cmd, args, opts) => {
        if(cmd === 'age') throw new Error('age exploded')
        await defaultRun(cmd, args, opts)
      },
    })).rejects.toThrow('age exploded')
    expect(fs.readdirSync(out)).toEqual([])
  })

  it.skipIf(!hasBinary('age') || !hasBinary('age-keygen'))('encrypts for real with age', async () => {
    const identity = path.join(dir, 'key.txt')
    execFileSync('age-keygen', ['-o', identity], { stdio: 'ignore' })
    const recipient = execFileSync('age-keygen', ['-y', identity], { encoding: 'utf8' })
    fs.writeFileSync(path.join(dir, 'backup.pub'), recipient)

    const result = await createBackup({
      db,
      configPath: path.join(dir, 'config.yaml'),
      sshKeyDir: path.join(dir, 'ssh'),
      backupPubPath: path.join(dir, 'backup.pub'),
      workDir: path.join(dir, 'out'),
    })

    expect(fs.readFileSync(result.file).subarray(0, 21).toString()).toBe('age-encryption.org/v1')
    const tar = path.join(dir, 'decrypted.tar')
    execFileSync('age', ['-d', '-i', identity, '-o', tar, result.file])
    const listing = execFileSync('tar', ['-tf', tar], { encoding: 'utf8' }).trim().split('\n').sort()
    expect(listing).toEqual(['config.yaml', 'ssh/id_ed25519', 'ssh/id_ed25519.pub', 'state.db'])
  })
})
