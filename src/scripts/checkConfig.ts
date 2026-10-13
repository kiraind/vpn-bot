import 'dotenv/config'
import { DEFAULT_CONFIG_PATH, loadConfigFile } from '../config/load'

// npm run check-config [-- <path>]: validate config.yaml without starting the coordinator (R-O2).
const path = process.argv[2] || DEFAULT_CONFIG_PATH
const result = loadConfigFile(path, process.env)

if(!result.ok) {
  console.error(`config INVALID: ${path}`)
  for(const error of result.errors) console.error(`  ${error}`)
  process.exit(1)
}

const { config } = result
console.log(`config OK: ${path}`)
console.log(`  api: ${config.api.listen} -> ${config.api.publicUrl}`)
console.log(`  clients: ${config.clients.subnet}, mtu ${config.clients.mtu}, ${config.clients.protocol}`)
console.log(`  tunnel: ${config.tunnel.subnet}, mtu ${config.tunnel.mtu}, ${config.tunnel.protocol}`)
for(const site of config.sites) {
  const { local, remote } = site
  console.log(`  site ${site.name}:`)
  console.log(`    local (${local.country}): client ${local.addresses.client}, outer ${local.addresses.outer}, tunnel ${local.addresses.tunnel}, ssh ${local.ssh.user}@${local.addresses.outer}:${local.ssh.port}`)
  console.log(`    remote: outer ${remote.addresses.outer}, tunnel ${remote.addresses.tunnel}, ssh ${remote.ssh.user}@${remote.addresses.outer}:${remote.ssh.port}`)
}
