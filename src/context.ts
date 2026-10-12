import { EventEmitter } from 'events'
import type { Db } from './db'
import type { CoordinatorConfig } from './config/schema'

// Process-wide wiring shared by bot, API, reconciler and cron jobs. Built once in index.ts;
// tests build their own with a ':memory:' DB and stub `alert`.

export interface AlertOptions {
  /** Also post to the users' chat (only network up/down, R-H4); requires telegram.announceOutages. */
  announce?: boolean
}

export interface AppEvents {
  /** Client peers changed (config added/revoked/suspended): LOCAL needs an apply (R-P1, R-P4). */
  'peers-changed': []
  /** Node identity changed (/rotate): every node of the site needs an apply. */
  'identity-changed': [site: string]
}

export interface AppContext {
  db: Db
  /** Last valid config (R-C1). */
  config(): CoordinatorConfig
  events: EventEmitter<AppEvents>
  /** Message to telegram.admins (and the users' chat when `announce`). Never throws. */
  alert(text: string, opts?: AlertOptions): Promise<void>
}

export function createEvents(): EventEmitter<AppEvents> {
  return new EventEmitter<AppEvents>()
}
