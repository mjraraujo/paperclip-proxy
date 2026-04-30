# Legacy

These files predate the Mission Control web dashboard and are kept here
purely for reference. They're **not** built into the current Docker
image and are not part of the published bin entry.

* `server.js` — original Express-based proxy with custom OAuth (now
  superseded by `bin/gateway.js`, which uses the Codex device-code
  flow shared with the dashboard).
* `setup.js` — interactive wizard that wrote `.env` for `server.js`.
  No longer relevant.

If you only need the proxy, use `node bin/gateway.js`. If you want the
full UI, run `cd web && npm install && npm run dev` (or use the
container — see the root `Dockerfile`).
