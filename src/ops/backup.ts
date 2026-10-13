import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import type { Db } from '../db'
import { DEFAULT_BACKUP_PUB } from '../paths'

export type RunCommand = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<void>

export interface BackupOptions {
  db: Db
  configPath: string
  sshKeyDir: string
  backupPubPath?: string
  // Where the encrypted file lands; defaults to a fresh private temp dir.
  workDir?: string
  date?: Date
  run?: RunCommand
}

export interface BackupResult {
  file: string
  name: string
}

const execFileAsync = promisify(execFile)

export const defaultRun: RunCommand = async (cmd, args, opts) => {
  await execFileAsync(cmd, args, { cwd: opts?.cwd })
}

export function backupFileName(date: Date): string {
  return `vpn-backup-${date.toISOString().slice(0, 10)}.tar.age`
}

// Daily backup (R-S5): DB + config.yaml + coordinator SSH key, tarred and encrypted with age to
// the admin's public key. The SSH key is the only way into the nodes after bootstrap, so a backup
// without it would be useless for disaster recovery (runbook 3.6).
export async function createBackup(opts: BackupOptions): Promise<BackupResult> {
  const backupPubPath = opts.backupPubPath ?? DEFAULT_BACKUP_PUB
  const run = opts.run ?? defaultRun

  if(!fs.existsSync(backupPubPath)) {
    throw new Error(`backup.pub not found: ${backupPubPath} (put the admin's age public key there, runbook 1.2.5)`)
  }
  const privateKey = path.join(opts.sshKeyDir, 'id_ed25519')
  const publicKey = path.join(opts.sshKeyDir, 'id_ed25519.pub')
  if(!fs.existsSync(opts.configPath)) throw new Error(`config not found: ${opts.configPath}`)
  if(!fs.existsSync(privateKey)) throw new Error(`coordinator SSH key not found: ${privateKey}`)

  const workDir = opts.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-backup-'))
  fs.mkdirSync(workDir, { recursive: true })
  const name = backupFileName(opts.date ?? new Date())
  const file = path.join(workDir, name)

  // mkdtemp is 0700, so the plaintext staging copy and tar are never readable by others.
  const tmpRoot = fs.mkdtempSync(path.join(workDir, '.staging-'))
  try {
    const staging = path.join(tmpRoot, 'staging')
    fs.mkdirSync(path.join(staging, 'ssh'), { recursive: true, mode: 0o700 })

    // Online backup API gives a consistent snapshot even while the coordinator keeps writing (WAL).
    await opts.db.backup(path.join(staging, 'state.db'))
    fs.copyFileSync(opts.configPath, path.join(staging, 'config.yaml'))
    fs.copyFileSync(privateKey, path.join(staging, 'ssh', 'id_ed25519'))
    const entries = ['state.db', 'config.yaml', 'ssh/id_ed25519']
    if(fs.existsSync(publicKey)) {
      fs.copyFileSync(publicKey, path.join(staging, 'ssh', 'id_ed25519.pub'))
      entries.push('ssh/id_ed25519.pub')
    }

    const tarPath = path.join(tmpRoot, 'backup.tar')
    await run('tar', ['-C', staging, '-cf', tarPath, ...entries])

    fs.rmSync(file, { force: true })
    await run('age', ['-R', backupPubPath, '-o', file, tarPath])
    fs.chmodSync(file, 0o600)
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }

  return { file, name }
}
