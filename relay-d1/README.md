# Watashi Relay D1

Cloudflare Worker relay for `watashi` with:

- outbound-only WebSocket relay
- token verification
- session fan-out via Durable Objects
- audit persistence in D1

## Bindings

- `RELAY_DB`: D1 database for audit logs
- `RELAY_SESSION`: Durable Object namespace for per-session routing
- `SS_SIGNING_KEY`: preferred secrets-store binding, matching the control plane
- `WATASHI_RELAY_SIGNING_KEY`: local/dev fallback

## Apply Schema

```bash
cd relay-d1
wrangler d1 execute watashi-relay-audit --file=./schema.sql
```

## Local Dev

```bash
cd relay-d1
export WATASHI_RELAY_SIGNING_KEY=...
wrangler dev
```

## Smoke Test

```bash
cd relay-d1
./scripts/smoke-test.sh
```

This starts local `wrangler dev`, opens two relay peers, sends one clipboard text frame, and verifies the D1 audit row.

## Endpoints

- `GET /healthz`
- `GET /auditz?session_id=<id>&limit=100`
- `WS /relay?session_id=...&peer_id=...&role=host|client&token=...`

## Notes

- clipboard text is relayed and audited as `clipboard-text`
- clipboard files and file transfer remain policy-gated
- the existing `relay/server.mjs` stays useful for local Node-only debugging; this Worker is the D1-backed enterprise path
