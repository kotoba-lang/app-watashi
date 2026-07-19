CREATE TABLE IF NOT EXISTS relay_audit_log (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  event TEXT NOT NULL,
  session_id TEXT,
  peer_id TEXT,
  source_peer_id TEXT,
  role TEXT,
  message_type TEXT,
  reason TEXT,
  managed_device INTEGER NOT NULL DEFAULT 0,
  remote TEXT
);

CREATE INDEX IF NOT EXISTS idx_relay_audit_session_ts
  ON relay_audit_log(session_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_relay_audit_peer_ts
  ON relay_audit_log(peer_id, ts DESC);
