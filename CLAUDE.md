# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Telegram bot that lets members of a specific Telegram chat self-service AmneziaWG VPN accounts. Membership in the configured Telegram chat is the sole access control: the bot creates/lists/revokes AmneziaWG peers and periodically revokes peers belonging to users who have left the chat. There is no HTTP admin API involved — the AmneziaWG server runs `awg`/`awg-quick` inside a Docker container, and this Node process (running on the host) manages it entirely by shelling out via `docker exec` (see `examples.md` for the reference commands this is built on).

## Commands

```
npm run dev      # run with nodemon + ts-node against src/index.ts
npm run build    # compile TypeScript to dist/ (tsc)
npm start         # run compiled dist/index.js
```

There is no test suite (`npm test` is a stub) and no linter configured.

Production deploy uses pm2 (see README.md):

```
npm ci && npm run build && pm2 start dist/index.js --name vpn-bot && pm2 save
```

The bot process needs permission to run `docker exec` against the AmneziaWG container (e.g. run as root, or as a user in the `docker` group).

## Configuration

Config is loaded from environment variables via dotenv in `src/config.ts`:

- `TELEGRAM_BOT_TOKEN` — bot token (required)
- `TELEGRAM_CHAT_ID` — the chat whose membership gates VPN access (required)
- `STATE_PATH` — directory for persisted JSON state (required)
- `AWG_CONTAINER` — name of the Docker container running AmneziaWG, e.g. `amnezia-awg2` (required)
- `AWG_ENDPOINT_HOST` — public host/IP put in client configs' `Endpoint =` (required); the port is read live from the server's `ListenPort`
- `AWG_DNS` — DNS server(s) put verbatim in client configs' `DNS =`, e.g. `172.29.172.254, 1.1.1.1` (required)
- `AWG_INTERFACE` — AmneziaWG interface name inside the container (optional, default `awg0`)
- `AWG_CONFIG_PATH` — path to the interface's conf file inside the container (optional, default `/opt/amnezia/awg/awg0.conf`)

`docker-compose.yml` in this repo is stale (it was for the old wg-easy deployment) — the AmneziaWG container is deployed/managed separately and is out of scope here.

## Architecture

**Entry point (`src/index.ts`)** wires up two things on startup:
1. A Telegram `text` message handler (`handleMessage`).
2. A cron job (`node-cron`, hourly) that checks Telegram membership for every known username in `STATE_PATH/users.json` and revokes that user's active AmneziaWG peers if they're no longer a chat member.

**State** is plain JSON files under `STATE_PATH`, no database:
- `users.json` — map of Telegram `username -> numeric user id`, populated the first time a user messages the bot.
- `clients.json` (`src/store/clients.ts`) — the durable record of every client ever created (`ClientRecord[]`, keyed by `id`/`name`), since a raw `awg0.conf` has no notion of client names or history. This is the *only* source of truth for client naming/ownership and for IP address allocation — it is never reconciled against the live container peer list. Revoked clients stay in this file with `enabled: false` (their address/PSK are never reused).

**Naming convention linking Telegram users to VPN clients**: every client record is named `"<telegram-username>:<device-id>"`. This is the *only* link between a Telegram identity and its VPN devices — ownership, listing, and removal are all done by string-matching `client.name.startsWith(`${username}:`)`. Device ids are restricted to `[a-z0-9-]+` (see `handleMessage.ts`).

**`src/checkMembership.ts`** wraps `bot.getChatMember`, retrying up to 5 times (5s apart) on failure before giving up. Returns `[isMember, reason]` where `isMember` is true only for status `administrator`/`creator`/`member`; used both by `handleMessage` (to gate bot commands) and by the hourly cron job (to decide who to ban).

**`src/awg/*`** is the only code that talks to the AmneziaWG container, all funneled through `exec.ts`'s `runInContainer(args, input?)` (spawns `docker exec [-i] <AWG_CONTAINER> ...args`, piping `input` to stdin when given — this is the sole place that shells out):
- `conf.ts` — a minimal parser/serializer for the `[Interface]`/`[Peer]` conf format (kept intentionally dumb: whole-file read-modify-write instead of `sed`/`awk` text surgery, because base64 keys contain `/` and `+` that break naive sed delimiters).
- `serverConfig.ts` — reads and parses the server's `awg0.conf`, deriving its public key from `PrivateKey` via `awg pubkey`; returns the client subnet prefix, `listenPort`, `publicKey`, and `extra` (every AmneziaWG obfuscation param — `Jc`, `Jmin`/`Jmax`, `S1`-`S4`, `H1`-`H4`, `HeaderProtectionKey`, etc. — copied verbatim into client configs so they always match the live server, never duplicated into env vars).
- `peers.ts` — `genKeyPair`/`genPresharedKey` (via `awg genkey`/`genpsk`/`pubkey`), and `addPeer`/`removePeer` (read the whole conf, mutate the `[Peer]` list, write the whole file back via `sh -c "cat > <path>"`, then non-disruptively reload with `awg syncconf <iface> <(awg-quick strip <path>)`).
- `clientConfigText.ts` — assembles the actual client `.conf` text from a `ClientRecord` + `ServerConfig`, matching the template in `examples.md`.

**Bot commands** (all handled in `handleMessage.ts`, gated on the sender being a member of `TELEGRAM_CHAT_ID` and having a Telegram username set):
- `/start`, `/info` — list the user's active devices. Traffic/usage stats are intentionally not tracked or shown (no monitoring).
- `/add <device-id>` — create a client named `<username>:<device-id>` (`store/clients.ts`'s `createClient`, which allocates the next free address, generates keys, and adds the peer to the live container), then send a QR code (generated locally with the `qrcode` package, no container round trip) and `.conf` file back; those messages plus the config are auto-deleted from the chat after 5 minutes.
- `/remove <device-id>` — revoke the matching client (`revokeClient`, shared with the hourly ban loop).

Bot replies are in Russian and use Telegram MarkdownV2 for the `/start`/`/info` summary.

Only DMs are handled: `handleMessage` bails out unless `msg.chat.id === msg.from.id`.
