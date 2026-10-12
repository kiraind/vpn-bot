import type { LocalRenderInput } from './input'
import { MARKS, NODE_PATHS } from './input'

// R-N4. rp_filter=2 (loose) because policy routing makes replies leave via a different table.
export function renderSysctl(): string {
  return [
    '# Managed by vpn-coordinator. Do not edit.',
    'net.ipv4.ip_forward = 1',
    'net.ipv4.conf.all.rp_filter = 2',
    'net.ipv4.conf.default.rp_filter = 2',
    'net.ipv6.conf.all.forwarding = 0',
    'net.ipv6.conf.default.forwarding = 0',
    '',
  ].join('\n')
}

/** Highest-ish metric so awgt's own `default dev awgt` (metric 0) always wins while it exists. */
const UNREACHABLE_METRIC = 4278198272

/**
 * LOCAL policy routing (R-L1, R-L3, R-L6). Runs at boot before awg-quick@awgt, idempotent,
 * so the node comes up on its own without the coordinator (R-P5).
 */
export function renderRoutingScript(input: LocalRenderInput): string {
  const { tunnelSource, viaRemote, tunnelTable, remoteTable } = MARKS
  return `#!/bin/bash
# Managed by vpn-coordinator (${input.node}). Do not edit.
set -euo pipefail

TUNNEL_SRC='${input.addresses.tunnel}'

# Wait for the main-table default route (network-online can race DHCP on some hosts).
for _ in $(seq 1 30); do
  DEF=$(ip -4 route show default | head -n1)
  [ -n "$DEF" ] && break
  sleep 1
done
if [ -z "\${DEF:-}" ]; then
  echo 'vpn-routing: no IPv4 default route in main table' >&2
  exit 1
fi
GW=$(awk '{for(i=1;i<NF;i++) if($i=="via"){print $(i+1); exit}}' <<<"$DEF")
DEV=$(awk '{for(i=1;i<NF;i++) if($i=="dev"){print $(i+1); exit}}' <<<"$DEF")
if [ -z "$DEV" ]; then
  echo "vpn-routing: cannot parse default route: $DEF" >&2
  exit 1
fi

add_rule() {
  local mark=$1 table=$2
  if ! ip -4 rule show | grep -qE "fwmark $mark(/0x[0-9a-f]+)? lookup $table\\b"; then
    ip -4 rule add fwmark "$mark" lookup "$table"
  fi
}
add_rule ${tunnelSource} ${tunnelTable}
add_rule ${viaRemote} ${remoteTable}

# awgt's own UDP packets leave from LOCAL.tunnel (R-L1).
if [ -n "$GW" ]; then
  ip -4 route replace default via "$GW" dev "$DEV" src "$TUNNEL_SRC" table ${tunnelTable}
else
  ip -4 route replace default dev "$DEV" src "$TUNNEL_SRC" table ${tunnelTable}
fi

# Fail closed: while awgt is down, traffic marked for REMOTE hits this instead of the main table (R-L6).
ip -4 route replace unreachable default metric ${UNREACHABLE_METRIC} table ${remoteTable}
`
}

export function renderRoutingUnit(): string {
  return `# Managed by vpn-coordinator. Do not edit.
[Unit]
Description=VPN node policy routing
After=network-online.target
Wants=network-online.target
Before=awg-quick@awgt.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${NODE_PATHS.routingScript}

[Install]
WantedBy=multi-user.target
`
}
