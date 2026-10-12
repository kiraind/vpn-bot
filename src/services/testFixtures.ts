import fs from 'node:fs'
import path from 'node:path'
import { parseConfigText } from '../config/load'
import type { CoordinatorConfig } from '../config/schema'

/** examples/config.example.yaml with dummy secrets, for service tests. */
export function exampleConfig(): CoordinatorConfig {
  const text = fs.readFileSync(path.join(__dirname, '../../examples/config.example.yaml'), 'utf8')
  const result = parseConfigText(text, { TELEGRAM_BOT_TOKEN: 't', MAIN_LOCAL_PASSWORD: 'a', MAIN_REMOTE_PASSWORD: 'b' })
  if(!result.ok) throw new Error(result.errors.join('\n'))
  return result.config
}
