import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'

// Coordinator state (spec section 6). One SQLite file; every module talks to it through
// the shared `Db` handle with its own prepared statements. Migrations are append-only:
// add a new entry to `migrations`, never edit an applied one.

export type Db = Database.Database

const migrations: string[] = [
  `
  CREATE TABLE users (
    tg_id INTEGER PRIMARY KEY,
    username TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    membership_checked_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE login_codes (
    code_hash TEXT PRIMARY KEY,
    tg_id INTEGER NOT NULL REFERENCES users(tg_id),
    expires_at TEXT NOT NULL,
    used_at TEXT,
    failed_attempts INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE device_tokens (
    token_hash TEXT PRIMARY KEY,
    tg_id INTEGER NOT NULL REFERENCES users(tg_id),
    label TEXT,
    app_version TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT,
    revoked_at TEXT
  );
  CREATE INDEX device_tokens_tg_id ON device_tokens(tg_id);

  CREATE TABLE client_configs (
    id TEXT PRIMARY KEY,
    tg_id INTEGER NOT NULL REFERENCES users(tg_id),
    name TEXT NOT NULL,
    address TEXT NOT NULL,
    private_key TEXT NOT NULL,
    public_key TEXT NOT NULL,
    preshared_key TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'suspended', 'revoked')),
    -- 'bot' when the .conf was handed out by the bot; R-O5 re-sends to these owners.
    issued_via TEXT NOT NULL CHECK (issued_via IN ('bot', 'api')),
    -- revision the owner last received (bot message or API fetch).
    delivered_revision TEXT,
    -- set once the config was fetched through the API at least once.
    api_fetched_at TEXT,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE UNIQUE INDEX client_configs_live_name ON client_configs(tg_id, name) WHERE state != 'revoked';
  CREATE UNIQUE INDEX client_configs_live_address ON client_configs(address) WHERE state != 'revoked';

  CREATE TABLE nodes (
    name TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK (role IN ('local', 'remote')),
    identity TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE hosts (
    node TEXT PRIMARY KEY REFERENCES nodes(name),
    address TEXT NOT NULL,
    applied_hash TEXT,
    phase TEXT NOT NULL DEFAULT 'pending',
    last_ok_at TEXT,
    last_error TEXT,
    last_error_at TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    health TEXT NOT NULL DEFAULT 'unknown',
    health_checked_at TEXT,
    health_detail TEXT
  );

  -- TOFU host keys, per address (R-P6). trusted_key NULL = pin on next connect.
  CREATE TABLE known_hosts (
    address TEXT PRIMARY KEY,
    host_key TEXT,
    first_seen_at TEXT NOT NULL,
    mismatch_key TEXT
  );

  CREATE TABLE sites (
    name TEXT PRIMARY KEY,
    network TEXT NOT NULL DEFAULT 'down' CHECK (network IN ('ok', 'degraded', 'down')),
    checked_at TEXT
  );

  CREATE TABLE geo_sets (
    country TEXT PRIMARY KEY,
    cidrs TEXT NOT NULL,
    count INTEGER NOT NULL,
    source TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  );
  `,
  `
  -- /revoke_user is permanent: a revoked user is never reactivated by rejoining the chat.
  ALTER TABLE users ADD COLUMN revoked_at TEXT;

  -- Bot messages to auto-delete (configs), so the deletion survives a restart.
  CREATE TABLE pending_deletions (
    chat_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    delete_at TEXT NOT NULL,
    PRIMARY KEY (chat_id, message_id)
  );
  `,
]

export function openDb(file: string): Db {
  if(file !== ':memory:') {
    // The DB holds every client and node private key.
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.chmodSync(path.dirname(file), 0o700)
  }

  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)

  return db
}

function migrate(db: Db) {
  const current = db.pragma('user_version', { simple: true }) as number

  for(let version = current; version < migrations.length; version += 1) {
    db.transaction(() => {
      db.exec(migrations[version])
      db.pragma(`user_version = ${version + 1}`)
    })()
  }
}

export function now(): string {
  return new Date().toISOString()
}
