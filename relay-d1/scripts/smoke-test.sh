#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8899}"
SIGNING_KEY="${WATASHI_RELAY_SIGNING_KEY:-test-signing-key}"
LOG_FILE="$(mktemp)"

cleanup() {
  if [[ -n "${DEV_PID:-}" ]] && kill -0 "${DEV_PID}" >/dev/null 2>&1; then
    kill "${DEV_PID}" >/dev/null 2>&1 || true
    wait "${DEV_PID}" >/dev/null 2>&1 || true
  fi
  rm -f "${LOG_FILE}"
}
trap cleanup EXIT

cd "${ROOT_DIR}"

wrangler d1 execute watashi-relay-audit --local --file=./schema.sql >/dev/null
wrangler dev --var "WATASHI_RELAY_SIGNING_KEY:${SIGNING_KEY}" --port "${PORT}" >"${LOG_FILE}" 2>&1 &
DEV_PID=$!

for _ in $(seq 1 40); do
  if curl -sf "http://localhost:${PORT}/healthz" >/dev/null; then
    break
  fi
  sleep 0.25
done

if ! curl -sf "http://localhost:${PORT}/healthz" >/dev/null; then
  cat "${LOG_FILE}" >&2
  echo "relay-d1 failed to become healthy" >&2
  exit 1
fi

deno run --allow-net ./src/smoke_client.ts "http://localhost:${PORT}" "${SIGNING_KEY}"
