# Paperclip on Hostinger (single-VPS Docker)

This guide goes with [`docker-compose.hostinger.yml`](./docker-compose.hostinger.yml). It assumes a fresh Hostinger VPS (or any single-host Docker box) reachable on a public IP / domain.

## What this stack runs

- `db` — Postgres 17 (private to the compose network, no published port).
- `init` — one-shot: runs `paperclip onboard`, generates the bootstrap CEO invite, fetches `gateway.js` into a shared volume, then exits.
- `proxy` — Node container running [`proxy/bin/gateway.js --serve`](../proxy/bin/gateway.js). Owns the published `:3100` port on behalf of `server`. The Codex gateway itself listens on `127.0.0.1:18923` and is **not** published.
- `server` — Paperclip API + UI. Joins the proxy's network namespace via `network_mode: service:proxy` so it can hit the gateway on `127.0.0.1:18923`.

## Why the network looks like this

The Claude/Codex local adapters only route through the gateway when the base URL points at `127.0.0.1` (or `localhost`) on port `18923`. See `packages/adapters/{claude,codex}-local/src/server/execute.ts → isProxyAuth`. Setting `ANTHROPIC_BASE_URL=http://proxy:18923` would be ignored.

To satisfy that constraint without exposing the gateway publicly:

1. The `proxy` service holds the netns and the published `3100:3100` port.
2. The `server` joins the same netns via `network_mode: service:proxy`.
3. The `server` env sets `ANTHROPIC_BASE_URL=OPENAI_BASE_URL=http://127.0.0.1:18923` and `PAPERCLIP_PROXY_MODE=1`.

The gateway port (`18923`) is intentionally never published — it has no auth of its own and would otherwise let any internet host use your OpenAI/ChatGPT token.

## One-time setup

1. **Create a `.env` next to the compose file.** The stack refuses to start without these:

   ```env
   PAPERCLIP_PUBLIC_URL=https://paperclip.example.com
   PAPERCLIP_ALLOWED_HOSTNAMES=paperclip.example.com
   PAPERCLIP_AGENT_JWT_SECRET=$(openssl rand -hex 32)
   BETTER_AUTH_SECRET=$(openssl rand -hex 32)
   # Optional: pin the Paperclip image to a specific tag/digest
   # PAPERCLIP_IMAGE=ghcr.io/paperclipai/paperclip@sha256:...
   # Optional: pin gateway.js to a commit + verify checksum
   # GATEWAY_JS_URL=https://raw.githubusercontent.com/mjraraujo/paperclip-proxy/<sha>/proxy/bin/gateway.js
   # GATEWAY_JS_SHA256=<sha256 of that file>
   ```

   Generate the two secrets fresh — never reuse the old `change-me-please` defaults.

2. **Bootstrap the gateway token.** The proxy's `--serve` mode polls a `token.json` written by an interactive OpenAI device-code login. Do that once before bringing the stack up:

   ```sh
   docker compose -f docker/docker-compose.hostinger.yml \
     run --rm --entrypoint "" proxy \
     node /gateway/gateway.js --login
   ```

   This writes into the `codex-gateway-data` volume; subsequent `up -d` runs reuse it and auto-refresh.

   > If you skip this, the `proxy` container will start, but the gateway will block in `waitForToken(...)` for up to 24 h and never accept requests.

3. **Bring the stack up.**

   ```sh
   docker compose -f docker/docker-compose.hostinger.yml up -d
   docker compose -f docker/docker-compose.hostinger.yml logs -f init server proxy
   ```

   The `init` log prints the bootstrap-CEO invite URL once. Save it — it is no longer regenerated on every restart.

4. **Put TLS in front of `:3100`.** This stack does not terminate TLS. Use Caddy, nginx, or a Cloudflare Tunnel. `PAPERCLIP_ALLOWED_HOSTNAMES` must match the host the browser actually uses.

## Verifying the proxy is in the path

From the VPS:

```sh
# server health (via the netns it shares with proxy)
docker compose -f docker/docker-compose.hostinger.yml exec server \
  node -e "require('http').get('http://127.0.0.1:3100/api/health',r=>console.log(r.statusCode))"

# gateway health (private)
docker compose -f docker/docker-compose.hostinger.yml exec proxy \
  node -e "require('http').get('http://127.0.0.1:18923/health',r=>console.log(r.statusCode))"
```

Then trigger a Claude or Codex run from the dashboard and tail the proxy logs:

```sh
docker compose -f docker/docker-compose.hostinger.yml logs -f proxy
```

You should see `POST /v1/messages` (Claude) or `POST /v1/responses` (Codex) entries. If you see Claude/Codex hitting `api.anthropic.com` / `api.openai.com` directly, the env wiring on `server` is wrong.

## Common failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| `proxy` container running but every Claude run still costs Anthropic credits | `ANTHROPIC_BASE_URL` not set, or hostname not loopback | Use this compose file unmodified; do not change `network_mode`. |
| `proxy` logs `⏳ No token yet — waiting for web dashboard login...` forever | Step 2 above was skipped | Run the `--login` one-shot, then `docker compose restart proxy`. |
| `init` fails on first boot with `gateway.js sha256 mismatch` | `GATEWAY_JS_SHA256` set but doesn't match the URL contents | Recompute the checksum or unset the variable. |
| `compose up` errors with `required variable ... is missing a value` | Missing `.env` keys | Add the variable; the stack intentionally refuses defaults. |
| Browser sees "host not allowed" / redirects to localhost | `PAPERCLIP_ALLOWED_HOSTNAMES` / `PAPERCLIP_PUBLIC_URL` don't match the public hostname | Set both to the real domain you serve over TLS. |

## Upgrading

- Pin `PAPERCLIP_IMAGE` to a digest in `.env`. Bump it in a single commit so rollbacks are obvious.
- When updating `gateway.js`, also bump `GATEWAY_JS_URL` (to the new commit SHA, not `main`) and `GATEWAY_JS_SHA256`. The `init` downloader verifies the hash and aborts on mismatch.
