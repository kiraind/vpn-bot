import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { utils } from 'ssh2'
import { promisify } from 'util'
import { DEFAULT_CONFIG_PATH, DEFAULT_DB_PATH, DEFAULT_SSH_KEY_DIR } from '../paths'

export interface RestoreTargets {
  dbPath: string
  configPath: string
  sshKeyDir: string
}

export const DEFAULT_RESTORE_TARGETS: RestoreTargets = {
  dbPath: DEFAULT_DB_PATH,
  configPath: DEFAULT_CONFIG_PATH,
  sshKeyDir: DEFAULT_SSH_KEY_DIR,
}

function derivePublicKey(privateKey: string): string {
  const parsed = utils.parseKey(privateKey)
  const key = Array.isArray(parsed) ? parsed[0] : parsed
  if(key instanceof Error) throw new Error(`cannot parse restored SSH key: ${key.message}`)
  return `${key.type} ${key.getPublicSSH().toString('base64')} vpn-coordinator`
}

const REQUIRED = ['state.db', 'config.yaml', 'ssh/id_ed25519']

const execFileAsync = promisify(execFile)

// Lays a DECRYPTED backup (runbook 3.6) back onto disk. Returns human-readable lines of what was done.
export async function restoreBackup(tarPath: string, targets: RestoreTargets, opts: { force?: boolean } = {}): Promise<string[]> {
  if(!fs.existsSync(tarPath)) throw new Error(`backup not found: ${tarPath}`)

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-restore-'))
  try {
    await execFileAsync('tar', ['-C', tmp, '--no-same-owner', '-xf', tarPath])

    // Only plain files count: a symlink in a crafted archive must not make us copy arbitrary host files.
    const isFile = (rel: string) => {
      const stat = fs.lstatSync(path.join(tmp, rel), { throwIfNoEntry: false })
      return !!stat && stat.isFile()
    }
    const missing = REQUIRED.filter(rel => !isFile(rel))
    if(missing.length) throw new Error(`backup is incomplete, missing: ${missing.join(', ')}`)

    const sshPrivate = path.join(targets.sshKeyDir, 'id_ed25519')
    const sshPublic = path.join(targets.sshKeyDir, 'id_ed25519.pub')
    const hasPublic = isFile('ssh/id_ed25519.pub')

    const plan: { from: string, to: string, mode: number }[] = [
      { from: 'state.db', to: targets.dbPath, mode: 0o600 },
      { from: 'config.yaml', to: targets.configPath, mode: 0o600 },
      { from: 'ssh/id_ed25519', to: sshPrivate, mode: 0o600 },
    ]
    if(hasPublic) plan.push({ from: 'ssh/id_ed25519.pub', to: sshPublic, mode: 0o644 })

    const existing = [...plan.map(p => p.to), ...(hasPublic ? [] : [sshPublic])].filter(to => fs.existsSync(to))
    if(existing.length && !opts.force) {
      throw new Error(`refusing to overwrite existing files (use --force): ${existing.join(', ')}`)
    }

    const done: string[] = []
    // Stale WAL/SHM next to a replaced DB would be replayed onto the restored file and corrupt it.
    for(const suffix of ['-wal', '-shm']) {
      const side = targets.dbPath + suffix
      if(fs.existsSync(side)) {
        fs.rmSync(side)
        done.push(`removed stale ${side}`)
      }
    }

    fs.mkdirSync(path.dirname(targets.dbPath), { recursive: true })
    fs.mkdirSync(path.dirname(targets.configPath), { recursive: true })
    fs.mkdirSync(targets.sshKeyDir, { recursive: true, mode: 0o700 })
    fs.chmodSync(targets.sshKeyDir, 0o700)

    for(const p of plan) {
      const overwrite = fs.existsSync(p.to)
      fs.copyFileSync(path.join(tmp, p.from), p.to)
      fs.chmodSync(p.to, p.mode)
      done.push(`${overwrite ? 'overwrote' : 'installed'} ${p.to} (${p.mode.toString(8)})`)
    }
    if(!hasPublic) {
      // ensureCoordinatorKey regenerates BOTH halves when the .pub is missing, which would throw away
      // the restored key, so derive the public half here.
      fs.writeFileSync(sshPublic, `${derivePublicKey(fs.readFileSync(sshPrivate, 'utf8'))}\n`, { mode: 0o644 })
      fs.chmodSync(sshPublic, 0o644)
      done.push(`derived ${sshPublic} from the private key (backup had none)`)
    }

    return done
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

async function main() {
  const args = process.argv.slice(2)
  const force = args.includes('--force')
  const positional = args.filter(a => a !== '--force')
  if(positional.length !== 1) {
    console.error('usage: npm run restore -- <backup.tar> [--force]')
    console.error('  <backup.tar> is the DECRYPTED backup: age -d -i vpn-backup.key vpn-backup-….tar.age > backup.tar')
    process.exit(2)
  }

  try {
    const done = await restoreBackup(positional[0], DEFAULT_RESTORE_TARGETS, { force })
    for(const line of done) console.log(line)
    console.log('restore OK. Next: put backup.pub in place and start the coordinator (runbook 1.2.5, 1.2.7).')
  } catch(err) {
    console.error(`restore FAILED: ${(err as Error).message}`)
    process.exit(1)
  }
}

if(require.main === module) main()
