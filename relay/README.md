# Watashi Relay

Minimal outbound-only relay for `watashi` remote sessions.

## Purpose

- terminate WSS connections from `watashi-host`
- verify HMAC-signed control-plane tokens
- forward input frames between peers in the same session
- enforce simple input, clipboard, and file policy

This relay is intentionally minimal. Audit logs are in-memory only and exposed over HTTP for debugging. For enterprise persistence, use [`relay-d1`](../relay-d1/README.md).

## Environment

Set one of:

- `WATASHI_RELAY_SIGNING_KEY`
- `SIGNING_KEY`

This must match the `SS_SIGNING_KEY` used by the `watashi` control plane when issuing relay tokens.

## Run

```bash
cd relay
npm install
WATASHI_RELAY_SIGNING_KEY=... npm start
```

Default port is `8788`.

## Endpoints

- `GET /healthz`
- `GET /auditz`
- `WS /?session_id=...&peer_id=...&role=host|client&token=...`

## Policy Enforcement

The relay inspects the incoming message `type` and applies token-carried policy:

- `input` uses `allowInputInbound` / `allowInputOutbound`
- `clipboard` with `clipboard_kind=text|file` uses `allowClipboardText` / `allowClipboardFile`
- `file-meta` uses `allowFileTransfer`

Denied messages generate audit events.

## Flow

1. Control plane calls `com.etzhayyim.apps.watashi.issueRelaySession`
2. It returns `host.token` and `client.token`
3. Each peer connects with:

```bash
watashi --relay-host ws://relay.example.com:8788 --session <id> --peer <peer> --token <jwt>
watashi --relay-client ws://relay.example.com:8788 --session <id> --peer <peer> --token <jwt>
```
