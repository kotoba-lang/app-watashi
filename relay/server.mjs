import crypto from "node:crypto";
import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8788);
const SIGNING_KEY = process.env.WATASHI_RELAY_SIGNING_KEY || process.env.SIGNING_KEY || "";
const MAX_AUDIT_EVENTS = Number(process.env.WATASHI_RELAY_MAX_AUDIT || 200);

if (!SIGNING_KEY) {
  throw new Error("WATASHI_RELAY_SIGNING_KEY or SIGNING_KEY is required");
}

const sessions = new Map();
const auditLog = [];

function base64urlToBuffer(input) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  return Buffer.from(padded, "base64");
}

function decodeToken(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid token");
  const [headerB64, payloadB64, sigB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;
  const expected = crypto
    .createHmac("sha256", SIGNING_KEY)
    .update(signingInput)
    .digest("base64url");
  if (expected !== sigB64) throw new Error("invalid signature");
  const payload = JSON.parse(base64urlToBuffer(payloadB64).toString("utf8"));
  if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) {
    throw new Error("expired token");
  }
  return payload;
}

function sessionEntry(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { peers: new Map() });
  }
  return sessions.get(sessionId);
}

function recordAudit(event) {
  auditLog.push({
    ts: new Date().toISOString(),
    ...event,
  });
  if (auditLog.length > MAX_AUDIT_EVENTS) auditLog.splice(0, auditLog.length - MAX_AUDIT_EVENTS);
}

function messageKind(message) {
  const kind = String(message?.type || "");
  if (kind === "clipboard") {
    const clipboardKind = String(message?.clipboard_kind || message?.clipboardKind || "text");
    return clipboardKind === "file" ? "clipboard-file" : "clipboard-text";
  }
  if (kind === "file-meta") return "file-meta";
  if (kind === "audit") return "audit";
  return "input";
}

function canSend(policy, kind) {
  if (kind === "input") return Boolean(policy?.allowInputOutbound);
  if (kind === "clipboard-text") return Boolean(policy?.allowClipboardText);
  if (kind === "clipboard-file") return Boolean(policy?.allowClipboardFile);
  if (kind === "file-meta") return Boolean(policy?.allowFileTransfer);
  if (kind === "audit") return true;
  return false;
}

function canReceive(policy, kind) {
  if (kind === "input") return Boolean(policy?.allowInputInbound);
  if (kind === "clipboard-text") return Boolean(policy?.allowClipboardText);
  if (kind === "clipboard-file") return Boolean(policy?.allowClipboardFile);
  if (kind === "file-meta") return Boolean(policy?.allowFileTransfer);
  if (kind === "audit") return true;
  return false;
}

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
    return;
  }
  if (req.url?.startsWith("/auditz")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, events: auditLog }));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws, req, claims) => {
  const { session_id: sessionId, peer_id: peerId, role, policy } = claims;
  const entry = sessionEntry(sessionId);
  entry.peers.set(peerId, { ws, role, policy });
  recordAudit({
    event: "peer_connected",
    session_id: sessionId,
    peer_id: peerId,
    role,
    managed_device: Boolean(policy?.managedDevice),
  });

  ws.send(JSON.stringify({
    type: "control",
    event: "connected",
    session_id: sessionId,
    peer_id: peerId,
    role,
  }));

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString("utf8"));
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "invalid_json" }));
      recordAudit({
        event: "invalid_json",
        session_id: sessionId,
        peer_id: peerId,
      });
      return;
    }

    const kind = messageKind(message);

    if (!canSend(policy, kind)) {
      ws.send(JSON.stringify({ type: "error", error: "policy_denied_outbound", message_type: kind }));
      recordAudit({
        event: "policy_denied_outbound",
        session_id: sessionId,
        peer_id: peerId,
        message_type: kind,
      });
      return;
    }

    for (const [otherPeerId, peer] of entry.peers.entries()) {
      if (otherPeerId === peerId) continue;
      if (!canReceive(peer.policy, kind)) {
        recordAudit({
          event: "policy_denied_inbound",
          session_id: sessionId,
          peer_id: otherPeerId,
          source_peer_id: peerId,
          message_type: kind,
        });
        continue;
      }
      if (peer.ws.readyState !== peer.ws.OPEN) continue;
      peer.ws.send(JSON.stringify({
        ...message,
        session_id: sessionId,
        from_peer_id: peerId,
      }));
      recordAudit({
        event: "message_forwarded",
        session_id: sessionId,
        peer_id: otherPeerId,
        source_peer_id: peerId,
        message_type: kind,
      });
    }
  });

  ws.on("close", () => {
    entry.peers.delete(peerId);
    if (entry.peers.size === 0) sessions.delete(sessionId);
    recordAudit({
      event: "peer_disconnected",
      session_id: sessionId,
      peer_id: peerId,
      role,
    });
  });
});

server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token");
    const sessionId = url.searchParams.get("session_id");
    const peerId = url.searchParams.get("peer_id");
    const role = url.searchParams.get("role");
    if (!token || !sessionId || !peerId || !role) {
      throw new Error("missing required query params");
    }

    const claims = decodeToken(token);
    if (claims.session_id !== sessionId) throw new Error("session mismatch");
    if (claims.peer_id !== peerId) throw new Error("peer mismatch");
    if (claims.role !== role) throw new Error("role mismatch");
    if (claims.aud !== "watashi-relay") throw new Error("aud mismatch");

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, claims);
    });
  } catch (error) {
    recordAudit({
      event: "upgrade_rejected",
      reason: String(error?.message || error),
      remote: String(req.socket.remoteAddress || ""),
    });
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`watashi-relay listening on :${PORT}`);
});
