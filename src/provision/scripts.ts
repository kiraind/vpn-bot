import type { RenderedFile } from '../types'
import { MARKS, NFT_TABLE, NODE_PATHS } from '../render/node/input'
import { packTar } from './tar'

// Bash run on nodes over SSH (spec 7.2, 7.3). Everything a node needs to come back after a
// reboot lives in its own files (R-P5); these scripts only install and (re)start them.

/** Bump whenever any script below changes; the reconciler mixes it into desiredHash. */
export const SCRIPTS_VERSION = '2'

/** Exit codes the reconciler maps to the runbook's error strings (runbook 3.5). */
export const EXIT_CODES = {
  unsupportedOs: 10,
  moduleBuildFailed: 11,
  addressMissing: 20,
  selfCheckFailed: 30,
  interfaceFailed: 31,
  routingFailed: 32,
  rebootRequired: 100,
} as const

/** Line printed (with exit 100) when the node must reboot before bootstrap can continue. */
export const REBOOT_REQUIRED = 'REBOOT_REQUIRED'

/** Line bootstrap prints on success; the coordinator requires it, so an early exit 0 is a failure. */
export const BOOTSTRAP_OK = 'BOOTSTRAP_OK'

/**
 * These scripts are fed to `bash -s` on stdin, and bash reads a piped script command by command:
 * a child that reads stdin (dpkg maintainer scripts, debconf, dkms) would swallow the rest and the
 * script would end with exit 0. Wrapping the body in main() makes bash parse it all before running.
 */
function wrapMain(head: string, body: string): string {
  return `#!/bin/bash
${head}set -euo pipefail

main() {
${body}}

main "$@"
`
}

/** POSIX single-quote escaping: safe for any string, including newlines. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export function bootstrapScript(): string {
  return wrapMain('# Bootstrap a clean Ubuntu 24.04 node (spec 7.2). Idempotent: safe to re-run at any point.\n', `export DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1

os=$(. /etc/os-release 2>/dev/null && echo "$ID $VERSION_ID" || true)
if [ "$os" != "ubuntu 24.04" ]; then echo 'unsupported os' >&2; exit ${EXIT_CODES.unsupportedOs}; fi
case "$(uname -m)" in
  x86_64|aarch64) ;;
  *) echo 'unsupported os' >&2; exit ${EXIT_CODES.unsupportedOs} ;;
esac

apt_get() {
  apt-get -y -o DPkg::Lock::Timeout=600 \\
    -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@" </dev/null
}

apt_get update
apt_get full-upgrade
apt_get install software-properties-common nftables unattended-upgrades "linux-headers-$(uname -r)"
# Headers metapackage for the running flavour, so DKMS rebuilds the module for future kernels.
flavour=$(uname -r | sed 's/^[0-9.]*-[0-9]*-//')
if apt-cache show "linux-headers-$flavour" </dev/null >/dev/null 2>&1; then apt_get install "linux-headers-$flavour"; fi

if ! grep -rqs 'amnezia/ppa' /etc/apt/sources.list /etc/apt/sources.list.d/; then
  add-apt-repository -y ppa:amnezia/ppa </dev/null
  apt_get update
fi
apt_get install amneziawg amneziawg-tools
if ! awg --version </dev/null >/dev/null 2>&1; then echo 'amneziawg-tools broken: awg --version failed' >&2; exit 1; fi
tools_version=unknown
if command -v dpkg-query >/dev/null 2>&1; then
  tools_version=$(dpkg-query -W -f='\${Version}' amneziawg-tools 2>/dev/null </dev/null || echo unknown)
fi

cat > /etc/apt/apt.conf.d/52vpn-node-unattended <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
EOF
systemctl -q enable --now unattended-upgrades

# The coordinator renders the whole firewall into nftables.conf; ufw would fight over it.
if command -v ufw >/dev/null 2>&1; then
  ufw --force disable >/dev/null 2>&1 || true
  systemctl -q disable --now ufw 2>/dev/null || true
fi

echo amneziawg > /etc/modules-load.d/amneziawg.conf

running=$(uname -r)
newest=$(ls /boot/vmlinuz-* 2>/dev/null | sed 's|^/boot/vmlinuz-||' | sort -V | tail -n 1 || true)
kernel_pending=0
if [ -n "$newest" ] && [ "$newest" != "$running" ]; then kernel_pending=1; fi

if [ -e /var/run/reboot-required ]; then echo ${REBOOT_REQUIRED}; exit ${EXIT_CODES.rebootRequired}; fi

if ! modprobe amneziawg 2>/dev/null; then
  dkms autoinstall </dev/null >&2 || true
  if ! modprobe amneziawg; then
    if [ "$kernel_pending" = 1 ]; then echo ${REBOOT_REQUIRED}; exit ${EXIT_CODES.rebootRequired}; fi
    echo 'amneziawg module build failed' >&2
    exit ${EXIT_CODES.moduleBuildFailed}
  fi
fi

echo "${BOOTSTRAP_OK} amneziawg-tools=\${tools_version:-unknown}"
`)
}

const SSH_KEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]+( [^\n\r]*)?$/

/** Adds the coordinator key to `<homeDir>/.ssh/authorized_keys` (spec 7.2 step 2). Idempotent. */
export function installKeyScript(publicKey: string, homeDir: string): string {
  const key = publicKey.trim()
  if(!SSH_KEY_RE.test(key)) throw new Error('installKeyScript: not a single-line OpenSSH public key')
  if(!homeDir.startsWith('/') || /[\n\r]/.test(homeDir)) throw new Error('installKeyScript: bad home dir')
  // Match on "type base64" only, so a changed comment doesn't add a duplicate line.
  const keyBody = key.split(' ').slice(0, 2).join(' ')
  return wrapMain('', `home=${shellQuote(homeDir)}
key=${shellQuote(key)}
body=${shellQuote(keyBody)}
owner=$(stat -c %u:%g "$home")
mkdir -p "$home/.ssh"
touch "$home/.ssh/authorized_keys"
if ! grep -qF -- "$body" "$home/.ssh/authorized_keys"; then
  # Make sure we start on a fresh line even if the file lacks a trailing newline.
  if [ -s "$home/.ssh/authorized_keys" ] && [ "$(tail -c 1 "$home/.ssh/authorized_keys")" != "" ]; then echo >> "$home/.ssh/authorized_keys"; fi
  printf '%s\\n' "$key" >> "$home/.ssh/authorized_keys"
fi
chown "$owner" "$home/.ssh" "$home/.ssh/authorized_keys"
chmod 700 "$home/.ssh"
chmod 600 "$home/.ssh/authorized_keys"
echo KEY_INSTALLED
`)
}

/** Only after a key login was verified (spec 7.2 step 2). 00- sorts first; sshd keeps the first value. */
export function disablePasswordScript(): string {
  return wrapMain('', `f=/etc/ssh/sshd_config.d/00-vpn-coordinator.conf
cat > "$f.tmp" <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
mv -f "$f.tmp" "$f"
chmod 644 "$f"
if ! sshd -t; then rm -f "$f"; echo 'sshd config check failed' >&2; exit 1; fi
systemctl try-reload-or-restart ssh
echo PASSWORD_DISABLED
`)
}

export function readMarkerCommand(): string {
  return `cat ${NODE_PATHS.marker} 2>/dev/null || echo '{}'`
}

/** Remote command reading the bundle tar from stdin into a fresh stage and running apply.sh. */
export function applyCommand(): string {
  return `set -e; d=$(mktemp -d /tmp/vpn-apply.XXXXXX); tar -xf - -o -C "$d"; exec bash "$d/apply.sh" "$d"`
}

// ROOT (default empty) prefixes every target path so tests can run apply.sh unprivileged.
export function applyScript(): string {
  return `#!/bin/bash
# apply.sh <stage>: installs a node's staged desired state (spec 7.3).
# Re-running with the same stage changes nothing but the marker's appliedAt (AC-P5).
set -euo pipefail
STAGE=\${1:?usage: apply.sh <stage>}
ROOT=\${ROOT:-}
trap 'rm -rf -- "$STAGE"' EXIT
. "$STAGE/meta.env"

AWG_DIR=${NODE_PATHS.awgDir}
NFT_CONF=${NODE_PATHS.nftables}
SYSCTL_CONF=${NODE_PATHS.sysctl}
ROUTING_SCRIPT=${NODE_PATHS.routingScript}
ROUTING_UNIT=${NODE_PATHS.routingUnit}
MARKER=${NODE_PATHS.marker}

fail() { echo "$2" >&2; exit "$1"; }

# 1. Addresses are configured by the admin (R-N3); check them before touching anything.
addrs=$(ip -4 -o addr show)
for a in $ADDRESSES; do
  if ! grep -Fq "inet $a/" <<<"$addrs"; then fail ${EXIT_CODES.addressMissing} "address $a not present on host"; fi
done

# 2. Install files whose content or mode differs; keep the old copy for the peer-only check.
changed=' '
while read -r mode path; do
  [ -n "$path" ] || continue
  src="$STAGE/files$path"
  dst="$ROOT$path"
  if [ -f "$dst" ] && cmp -s "$src" "$dst" && [ "$(stat -c %a "$dst")" = "$mode" ]; then continue; fi
  if [ -f "$dst" ]; then
    mkdir -p "$(dirname "$STAGE/old$path")"
    cp -p "$dst" "$STAGE/old$path"
  fi
  install -D -m "$mode" "$src" "$dst.vpn-new"
  mv -f "$dst.vpn-new" "$dst"
  changed="$changed$path "
done < "$STAGE/manifest"
is_changed() { [[ "$changed" == *" $1 "* ]]; }

# 3. Kernel params and firewall.
if is_changed "$SYSCTL_CONF"; then sysctl --system >/dev/null; fi
systemctl -q enable nftables
if is_changed "$NFT_CONF" || ! nft list table inet ${NFT_TABLE} >/dev/null 2>&1; then nft -f "$ROOT$NFT_CONF"; fi

# 4. AWG interfaces. A peers-only change is applied live (R-P4): syncconf keeps sessions.
head_of() { sed '/^[[]Peer[]]/,$d' "$1"; }
up_re='[<,]UP[,>]'
iface_up() {
  local out
  out=$(ip link show dev "$1" 2>/dev/null) || return 1
  [[ $out =~ $up_re ]]
}
for i in $INTERFACES; do
  conf="$AWG_DIR/$i.conf"
  if is_changed "$conf"; then
    old="$STAGE/old$conf"
    if iface_up "$i" && [ -f "$old" ] && [ "$(head_of "$old")" = "$(head_of "$ROOT$conf")" ]; then
      awg syncconf "$i" <(awg-quick strip "$i")
    else
      systemctl -q enable "awg-quick@$i"
      systemctl restart "awg-quick@$i" || fail ${EXIT_CODES.interfaceFailed} "awg-quick@$i failed to start"
    fi
  else
    systemctl -q enable --now "awg-quick@$i" || fail ${EXIT_CODES.interfaceFailed} "awg-quick@$i failed to start"
  fi
done

# Routing last: its routes reference the awg interfaces.
if [ -f "$ROOT$ROUTING_UNIT" ]; then
  if is_changed "$ROUTING_UNIT"; then systemctl daemon-reload; fi
  if is_changed "$ROUTING_UNIT" || is_changed "$ROUTING_SCRIPT"; then
    systemctl -q enable vpn-routing
    systemctl restart vpn-routing || fail ${EXIT_CODES.routingFailed} 'vpn-routing failed to start'
  else
    systemctl -q enable --now vpn-routing || fail ${EXIT_CODES.routingFailed} 'vpn-routing failed to start'
  fi
fi

# 5. Self-check.
for i in $INTERFACES; do
  ip link show dev "$i" >/dev/null 2>&1 || fail ${EXIT_CODES.selfCheckFailed} "self-check: interface $i missing"
done
nft list table inet ${NFT_TABLE} >/dev/null 2>&1 || fail ${EXIT_CODES.selfCheckFailed} 'self-check: nft table inet ${NFT_TABLE} missing'
if [ "$ROLE" = local ]; then
  rules=$(ip rule show)
  for m in ${MARKS.tunnelSource} ${MARKS.viaRemote}; do
    grep -Fq "fwmark $m " <<<"$rules" || fail ${EXIT_CODES.selfCheckFailed} "self-check: ip rule for fwmark $m missing"
  done
fi

# 6. Marker (R-N7), written atomically. MARKER_FIELDS is pre-rendered JSON from the coordinator.
marker="$ROOT$MARKER"
mkdir -p "$(dirname "$marker")"
printf '{%s,"appliedAt":"%s"}\\n' "$MARKER_FIELDS" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$marker.tmp"
chmod 644 "$marker.tmp"
mv -f "$marker.tmp" "$marker"

# 7. The stage dir is removed by the EXIT trap.
echo "APPLIED $HASH"
`
}

export interface ApplyMeta {
  node: string
  role: 'local' | 'remote'
  hash: string
  coordinatorVersion: string
  addresses: string[]
  interfaces: string[]
}

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const IFACE_RE = /^[a-z][a-z0-9]{0,14}$/

export function renderMetaEnv(meta: ApplyMeta): string {
  for(const a of meta.addresses) if(!IPV4_RE.test(a)) throw new Error(`apply bundle: bad address ${a}`)
  for(const i of meta.interfaces) if(!IFACE_RE.test(i)) throw new Error(`apply bundle: bad interface ${i}`)
  const markerFields = [
    `"node":${JSON.stringify(meta.node)}`,
    `"role":${JSON.stringify(meta.role)}`,
    `"appliedHash":${JSON.stringify(meta.hash)}`,
    `"coordinatorVersion":${JSON.stringify(meta.coordinatorVersion)}`,
  ].join(',')
  const vars: [string, string][] = [
    ['NODE', meta.node],
    ['ROLE', meta.role],
    ['HASH', meta.hash],
    ['COORDINATOR_VERSION', meta.coordinatorVersion],
    ['ADDRESSES', meta.addresses.join(' ')],
    ['INTERFACES', meta.interfaces.join(' ')],
    ['MARKER_FIELDS', markerFields],
  ]
  return vars.map(([k, v]) => `${k}=${shellQuote(v)}\n`).join('')
}

/** Tar to stream into `applyCommand()`: files/<abs path>, manifest ("<octal mode> <path>"), meta.env, apply.sh. */
export function buildApplyBundle(files: RenderedFile[], meta: ApplyMeta): Buffer {
  const manifest: string[] = []
  for(const f of files) {
    if(!f.path.startsWith('/') || /\s/.test(f.path) || f.path.split('/').includes('..')) {
      throw new Error(`apply bundle: bad file path ${f.path}`)
    }
    manifest.push(`${(f.mode & 0o7777).toString(8)} ${f.path}`)
  }
  return packTar([
    ...files.map(f => ({ path: `files${f.path}`, mode: f.mode, content: f.content })),
    { path: 'manifest', mode: 0o644, content: manifest.join('\n') + '\n' },
    { path: 'meta.env', mode: 0o600, content: renderMetaEnv(meta) },
    { path: 'apply.sh', mode: 0o755, content: applyScript() },
  ])
}
