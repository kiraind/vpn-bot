import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import YAML from 'yaml'
import { configSchema, type CoordinatorConfig } from './schema'

export const DEFAULT_CONFIG_PATH = process.env.VPN_COORDINATOR_CONFIG || '/etc/vpn-coordinator/config.yaml'

export type ConfigResult =
  | { ok: true, config: CoordinatorConfig }
  | { ok: false, errors: string[] }

// `${VAR}` is not valid YAML inside flow mappings (`{ password: ${X} }`: braces are flow
// indicators), so references are swapped for a plain-scalar-safe token before parsing
// and resolved afterwards, only inside string values. This also keeps env values with
// YAML-special characters (#, :, quotes) from being reinterpreted as YAML.
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
const TOKEN = /__ENV-([A-Za-z_][A-Za-z0-9_]*)-ENV__/g

function protectEnvRefs(text: string): string {
  return text.replace(ENV_REF, (_, name: string) => `__ENV-${name}-ENV__`)
}

function formatPath(path: PropertyKey[]): string {
  return path.length ? path.map(String).join('.') : '(root)'
}

function expandEnv(value: unknown, env: NodeJS.ProcessEnv, path: PropertyKey[], errors: string[]): unknown {
  if(typeof value === 'string') {
    return value.replace(TOKEN, (_, name: string) => {
      const resolved = env[name]
      if(resolved === undefined) {
        errors.push(`${formatPath(path)}: environment variable ${name} is not set`)
        return ''
      }
      return resolved
    })
  }
  if(Array.isArray(value)) {
    return value.map((item, index) => expandEnv(item, env, [...path, index], errors))
  }
  if(value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for(const [key, item] of Object.entries(value)) {
      out[key] = expandEnv(item, env, [...path, key], errors)
    }
    return out
  }
  return value
}

export function parseConfigText(text: string, env: NodeJS.ProcessEnv): ConfigResult {
  const doc = YAML.parseDocument(protectEnvRefs(text))
  if(doc.errors.length) {
    return { ok: false, errors: doc.errors.map(error => `yaml: ${error.message.split('\n')[0]}`) }
  }
  const errors: string[] = []
  const raw = expandEnv(doc.toJS(), env, [], errors)
  if(errors.length) return { ok: false, errors }

  const parsed = configSchema.safeParse(raw ?? {})
  if(!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map(issue => `${formatPath(issue.path)}: ${issue.message}`) }
  }
  return { ok: true, config: parsed.data }
}

export function loadConfigFile(path: string, env: NodeJS.ProcessEnv): ConfigResult {
  let text: string
  try {
    text = fs.readFileSync(path, 'utf8')
  } catch(error) {
    return { ok: false, errors: [`cannot read ${path}: ${(error as Error).message}`] }
  }
  return parseConfigText(text, env)
}

export interface ConfigWatcherOptions {
  env?: NodeJS.ProcessEnv
  intervalMs?: number
}

// Holds the last valid config (R-C1). Events:
//  'change' (config, previous | undefined) — a valid config that differs from the last one
//  'invalid' (errors) — reload failed; the last valid config stays in effect
export class ConfigWatcher extends EventEmitter {
  private current: CoordinatorConfig | undefined
  private currentJson: string | undefined
  private watching = false
  private readonly env: NodeJS.ProcessEnv
  private readonly intervalMs: number
  private readonly onFileChange = (curr: fs.Stats, prev: fs.Stats) => {
    if(curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size || curr.ino !== prev.ino) this.reload()
  }

  constructor(readonly path: string = DEFAULT_CONFIG_PATH, options: ConfigWatcherOptions = {}) {
    super()
    this.env = options.env ?? process.env
    this.intervalMs = options.intervalMs ?? 2000
  }

  get config(): CoordinatorConfig | undefined {
    return this.current
  }

  reload(): ConfigResult {
    const result = loadConfigFile(this.path, this.env)
    if(!result.ok) {
      this.emit('invalid', result.errors)
      return result
    }
    const json = JSON.stringify(result.config)
    if(json !== this.currentJson) {
      const previous = this.current
      this.current = result.config
      this.currentJson = json
      this.emit('change', result.config, previous)
    }
    return result
  }

  // Polling rather than fs.watch: editors that save via rename would orphan an inode watch.
  start(): void {
    if(this.watching) return
    this.watching = true
    fs.watchFile(this.path, { interval: this.intervalMs, persistent: false }, this.onFileChange)
  }

  stop(): void {
    if(!this.watching) return
    this.watching = false
    fs.unwatchFile(this.path, this.onFileChange)
  }
}
