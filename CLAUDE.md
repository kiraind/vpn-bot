# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The v2 "VPN coordinator": a single Node process that owns a two-hop AmneziaWG VPN (clients → LOCAL → REMOTE, traffic to the home country exits at LOCAL, everything else at REMOTE). Membership in one Telegram chat is the sole access control. The coordinator holds all state (declarative `config.yaml` + SQLite DB), provisions and reconciles clean Ubuntu 24.04 nodes over SSH, and serves two front ends: a Telegram bot and an HTTPS API for the AmneziaVPN fork ([kiraind/amnezia-client](https://github.com/kiraind/amnezia-client)). Nodes are cattle: replacing a server means changing its address/password in the config.

- Spec (Russian, numbered requirements `R-*` / acceptance criteria `AC-*`): `docs/spec/coordinator-spec.md`. Reference requirement numbers in code comments and commits.
- Ops runbook (Russian): `docs/spec/runbook.md`.
- `legacy/` is the old single-server bot (docker exec into one AmneziaWG container). Reference only — not built, not imported.

## Commands

```
npm run dev           # tsx watch src/index.ts
npm run build         # tsc → dist/
npm start             # node dist/index.js
npm test              # vitest run (unit tests live next to code as *.test.ts)
npm run typecheck     # tsc --noEmit -p tsconfig.test.json (includes tests)
npm run check-config [-- <path>]           # validate config.yaml without starting (needs build)
npm run restore -- <backup.tar> [--force]  # unpack a decrypted backup into DB/config/SSH-key paths (needs build)
npm run update        # git pull && npm ci && npm run build && npm run pm2:reload
npm run pm2:start | pm2:stop | pm2:restart | pm2:reload | pm2:delete | pm2:logs | pm2:save | pm2:startup
```

The pm2 process is named `vpn-coordinator`. CI (`.github/workflows/ci.yml`) runs typecheck, build and tests on Node 22; some tests need `nft` and `age` installed.

## Configuration

- `config.yaml` — default `/etc/vpn-coordinator/config.yaml`, override with `VPN_COORDINATOR_CONFIG`. Schema: `src/config/schema.ts` (zod), annotated example: `examples/config.example.yaml`. Holds only addresses, SSH credentials and policy (telegram bot/chat/admins, api listen/publicUrl, client subnet/MTU/DNS/protocol, tunnel, routing, sites with `local`/`remote` nodes). `${VAR}` references are expanded from the environment; `.env` in the working directory is loaded via dotenv, so secrets can live there.
- `VPN_COORDINATOR_DB` — SQLite path, default `/var/lib/vpn-coordinator/state.db`.
- Coordinator SSH key: `/var/lib/vpn-coordinator/ssh/id_ed25519` (generated on first start). Backup public key: `/etc/vpn-coordinator/backup.pub` (age recipient). See `src/paths.ts`.

## Architecture

`src/index.ts` wires everything: loads config, opens the DB, ensures the coordinator SSH key, starts the Telegram bot (polling, including `chat_member` updates), the fastify API on `api.listen`, the Reconciler (5-min cycles, 1-min health checks, weekly geo refresh), the hourly membership sweep, the daily backup at 03:00 server time, and re-sends stale bot-issued configs after node identity changes. `src/context.ts` is the shared `AppContext` (config, db, alert, events) built once there.

Module map:

- `config/` — `schema.ts` (zod schema, `CoordinatorConfig`), `load.ts` (YAML + `${VAR}` expansion, `DEFAULT_CONFIG_PATH`).
- `db/index.ts` — SQLite schema with append-only migrations; every module uses the shared `Db` handle.
- `types.ts` — shared domain types (node identity, rows).
- `services/` — business logic shared by bot and API: `users` (keyed by Telegram id), `membership` (chat checks; Telegram errors are `unknown`, never `not-member`), `auth` (login codes, device tokens, rate limiting), `configs` (client config issuance/revocation, revisions), `identity` (per-site node keys, ports, obfuscation params).
- `bot/` — `userCommands` (`/start`, `/info`, `/add`, `/remove`, `/login`, `/devices`), `adminCommands` (`/status`, `/apply`, `/trust`, `/rotate`, `/revoke_user`, `/backup`), `messenger` (thin Bot API seam for tests).
- `api/server.ts` — fastify client API under `/v1` (`auth/login`, `auth/logout`, `me`, `configs` create/get/status/revoke) plus `/healthz`.
- `render/` — `clientConfig` (client `.conf`) and `node/` (awg confs, nftables, sysctl, routing/systemd files for LOCAL and REMOTE).
- `reconcile/` — `desired` (config + DB → files + `desiredHash`), `loop` (periodic and event-driven apply per node), `control` (interface the admin commands use).
- `provision/` — `node` (bootstrap/apply over SSH), `scripts` (bash run on nodes: bootstrap, `apply.sh`; `SCRIPTS_VERSION`), `tar` (ustar writer for shipping the bundle via stdin).
- `ssh/` — `client` (ssh2 wrapper, sudo for non-root users, runbook error strings), `keys` (coordinator key), `knownHosts` (TOFU pinning).
- `health/` — `dump` (`awg show all dump` parser), `evaluate` (site health rules), `notify` (alert/announcement wording).
- `geo/` — db-ip country lite download, CIDR math, cached geo sets in the DB.
- `protocol/` — AWG protocol profiles (`awg2`) that generate obfuscation params.
- `crypto/` — X25519 WG keys in Node crypto, login codes/tokens and their hashes.
- `ops/backup.ts` — daily age-encrypted backup of DB + config + SSH key, sent to admins.
- `scripts/` — `checkConfig`, `restore` CLIs.

Key invariants:

- **Node identity lives in the DB and survives host replacement** (R-S3): keys, listen ports, obfuscation params and internal addresses are generated once per site, never in config. A new host gets the same identity, so clients only see a new Endpoint.
- **Render is pure** `(config, db) → files` plus `desiredHash`; the reconciler compares it to the node's applied hash and only applies on difference. Bump `SCRIPTS_VERSION` when node scripts change so the hash moves.
- **`apply.sh` applies peers-only changes live** via `awg syncconf <iface> <(awg-quick strip <iface>)` without dropping sessions; interface-level changes restart the interface.
- **SSH host keys are TOFU**: pinned on first contact; a mismatch blocks the node until an admin runs `/trust <node>`.
- **Login codes and device tokens are stored only as hashes** (R-S4).
- **The `/v1` API contract is shared with the AmneziaVPN fork** (kiraind/amnezia-client); old app builds stay in the wild, so changes must be backward compatible (R-A10). Change both repos together.
- **The runbook must be updated in the same change as any ops-visible change** (commands, paths, scenarios — R-O1).
- Bot replies are in Russian; admin replies are plain text, user replies may use MarkdownV2.
