import { DEFAULT_SSH_KEY_DIR } from './ssh/keys'

// Default on-disk locations (runbook section 0). Env overrides exist for tests and non-standard installs.
export const DEFAULT_DB_PATH = process.env.VPN_COORDINATOR_DB || '/var/lib/vpn-coordinator/state.db'
export const DEFAULT_BACKUP_PUB = '/etc/vpn-coordinator/backup.pub'
export { DEFAULT_SSH_KEY_DIR }
export { DEFAULT_CONFIG_PATH } from './config/load'
