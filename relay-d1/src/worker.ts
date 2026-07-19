/// <reference path="./worker-cloudflare.d.ts" />

export interface RelayPolicy {
  allowInputInbound?: boolean;
  allowInputOutbound?: boolean;
  allowClipboardText?: boolean;
  allowClipboardFile?: boolean;
  allowFileTransfer?: boolean;
  managedDevice?: boolean;
}

export interface RelayClaims {
  aud: string;
  exp: number;
  peer_id: string;
  policy?: RelayPolicy;
  role: string;
  session_id: string;
}

export interface Env {
  RELAY_DB: D1Database;
  RELAY_SESSION: DurableObjectNamespace<RelaySession>;
  SS_SIGNING_KEY?: string;
  WATASHI_RELAY_SIGNING_KEY?: string;
}

type RelayMessage = Record<string, unknown> & {
  type?: string;
  clipboard_kind?: string;
  clipboardKind?: string;
};

type PeerMeta = {
  managed_device: boolean;
  peer_id: string;
  policy: RelayPolicy;
  role: string;
  session_id: string;
};

function base64urlToBytes(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function decodeToken(token: string, signingKey: string): Promise<RelayClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid token");
  const [headerB64, payloadB64, sigB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  const expected = bytesToBase64url(new Uint8Array(signature));
  if (expected !== sigB64) throw new Error("invalid signature");
  const claims = JSON.parse(new TextDecoder().decode(base64urlToBytes(payloadB64))) as RelayClaims;
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) {
    throw new Error("expired token");
  }
  return claims;
}

export function messageKind(message: RelayMessage): string {
  const kind = String(message?.type || "");
  if (kind === "clipboard") {
    const clipboardKind = String(message?.clipboard_kind || message?.clipboardKind || "text");
    return clipboardKind === "file" ? "clipboard-file" : "clipboard-text";
  }
  if (kind === "file-meta") return "file-meta";
  if (kind === "audit") return "audit";
  return "input";
}

export function canSend(policy: RelayPolicy | undefined, kind: string): boolean {
  if (kind === "input") return Boolean(policy?.allowInputOutbound);
  if (kind === "clipboard-text") return Boolean(policy?.allowClipboardText);
  if (kind === "clipboard-file") return Boolean(policy?.allowClipboardFile);
  if (kind === "file-meta") return Boolean(policy?.allowFileTransfer);
  if (kind === "audit") return true;
  return false;
}

export function canReceive(policy: RelayPolicy | undefined, kind: string): boolean {
  if (kind === "input") return Boolean(policy?.allowInputInbound);
  if (kind === "clipboard-text") return Boolean(policy?.allowClipboardText);
  if (kind === "clipboard-file") return Boolean(policy?.allowClipboardFile);
  if (kind === "file-meta") return Boolean(policy?.allowFileTransfer);
  if (kind === "audit") return true;
  return false;
}

async function recordAudit(env: Env, event: Record<string, unknown>) {
  await env.RELAY_DB.prepare(
    `INSERT INTO relay_audit_log
      (id, ts, event, session_id, peer_id, source_peer_id, role, message_type, reason, managed_device, remote)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    crypto.randomUUID(),
    new Date().toISOString(),
    String(event.event || ""),
    event.session_id ? String(event.session_id) : null,
    event.peer_id ? String(event.peer_id) : null,
    event.source_peer_id ? String(event.source_peer_id) : null,
    event.role ? String(event.role) : null,
    event.message_type ? String(event.message_type) : null,
    event.reason ? String(event.reason) : null,
    event.managed_device ? 1 : 0,
    event.remote ? String(event.remote) : null,
  ).run();
}

function resolveSigningKey(env: Env): string {
  if (typeof env.WATASHI_RELAY_SIGNING_KEY === "string" && env.WATASHI_RELAY_SIGNING_KEY) {
    return env.WATASHI_RELAY_SIGNING_KEY;
  }
  if (typeof env.SS_SIGNING_KEY === "string" && env.SS_SIGNING_KEY) {
    return env.SS_SIGNING_KEY;
  }
  return "";
}

async function proxyToSession(request: Request, env: Env, claims: RelayClaims): Promise<Response> {
  const sessionId = claims.session_id;
  const id = env.RELAY_SESSION.idFromName(sessionId);
  const stub = env.RELAY_SESSION.get(id);
  const headers = new Headers(request.headers);
  headers.set("x-watashi-claims", JSON.stringify(claims));
  return stub.fetch("https://relay.internal/connect", {
    method: "GET",
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const signingKey = resolveSigningKey(env);

    if (request.method === "GET" && url.pathname === "/healthz") {
      const count = await env.RELAY_DB.prepare(
        "SELECT COUNT(*) AS n FROM relay_audit_log"
      ).first<{ n: number }>();
      return Response.json({ ok: true, audit_rows: count?.n ?? 0, signing_key_configured: Boolean(signingKey) });
    }

    if (request.method === "GET" && url.pathname === "/auditz") {
      const sessionId = url.searchParams.get("session_id");
      const limit = Math.min(Number(url.searchParams.get("limit") || 100), 500);
      const statement = sessionId
        ? env.RELAY_DB.prepare(
            `SELECT * FROM relay_audit_log
             WHERE session_id = ?
             ORDER BY ts DESC
             LIMIT ?`
          ).bind(sessionId, limit)
        : env.RELAY_DB.prepare(
            `SELECT * FROM relay_audit_log
             ORDER BY ts DESC
             LIMIT ?`
          ).bind(limit);
      const results = await statement.all();
      return Response.json({ ok: true, events: results.results ?? [] });
    }

    if (request.headers.get("Upgrade") !== "websocket" || url.pathname !== "/relay") {
      return new Response("not found", { status: 404 });
    }

    try {
      const token = url.searchParams.get("token");
      const sessionId = url.searchParams.get("session_id");
      const peerId = url.searchParams.get("peer_id");
      const role = url.searchParams.get("role");
      if (!token || !sessionId || !peerId || !role) {
        throw new Error("missing required query params");
      }
      if (!signingKey) throw new Error("signing key is not configured");

      const claims = await decodeToken(token, signingKey);
      if (claims.session_id !== sessionId) throw new Error("session mismatch");
      if (claims.peer_id !== peerId) throw new Error("peer mismatch");
      if (claims.role !== role) throw new Error("role mismatch");
      if (claims.aud !== "watashi-relay") throw new Error("aud mismatch");

      return proxyToSession(request, env, claims);
    } catch (error) {
      ctx.waitUntil(
        recordAudit(env, {
          event: "upgrade_rejected",
          reason: String(error instanceof Error ? error.message : error),
          remote: request.headers.get("CF-Connecting-IP") || "",
          session_id: url.searchParams.get("session_id") || "",
          peer_id: url.searchParams.get("peer_id") || "",
        })
      );
      return new Response("unauthorized", { status: 401 });
    }
  },
};

export class RelaySession implements DurableObject {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;
  private readonly peers = new Map<string, WebSocket>();

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    for (const ws of this.ctx.getWebSockets()) {
      const meta = ws.deserializeAttachment() as PeerMeta | null;
      if (meta?.peer_id) this.peers.set(meta.peer_id, ws);
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const claimsHeader = request.headers.get("x-watashi-claims");
    if (!claimsHeader) {
      return new Response("missing claims", { status: 401 });
    }
    const claims = JSON.parse(claimsHeader) as RelayClaims;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const meta: PeerMeta = {
      managed_device: Boolean(claims.policy?.managedDevice),
      peer_id: claims.peer_id,
      policy: claims.policy || {},
      role: claims.role,
      session_id: claims.session_id,
    };

    server.serializeAttachment(meta);
    this.ctx.acceptWebSocket(server);
    this.peers.set(meta.peer_id, server);
    this.ctx.waitUntil(
      recordAudit(this.env, {
        event: "peer_connected",
        session_id: meta.session_id,
        peer_id: meta.peer_id,
        role: meta.role,
        managed_device: meta.managed_device,
      })
    );
    server.send(
      JSON.stringify({
        type: "control",
        event: "connected",
        session_id: meta.session_id,
        peer_id: meta.peer_id,
        role: meta.role,
      })
    );

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const meta = ws.deserializeAttachment() as PeerMeta | null;
    if (!meta) return;

    let decoded: RelayMessage;
    try {
      const text =
        typeof message === "string" ? message : new TextDecoder().decode(new Uint8Array(message));
      decoded = JSON.parse(text) as RelayMessage;
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "invalid_json" }));
      await recordAudit(this.env, {
        event: "invalid_json",
        session_id: meta.session_id,
        peer_id: meta.peer_id,
      });
      return;
    }

    const kind = messageKind(decoded);
    if (!canSend(meta.policy, kind)) {
      ws.send(JSON.stringify({ type: "error", error: "policy_denied_outbound", message_type: kind }));
      await recordAudit(this.env, {
        event: "policy_denied_outbound",
        session_id: meta.session_id,
        peer_id: meta.peer_id,
        message_type: kind,
      });
      return;
    }

    for (const [otherPeerId, peerSocket] of this.peers.entries()) {
      if (otherPeerId === meta.peer_id) continue;
      const otherMeta = peerSocket.deserializeAttachment() as PeerMeta | null;
      if (!otherMeta) continue;
      if (!canReceive(otherMeta.policy, kind)) {
        await recordAudit(this.env, {
          event: "policy_denied_inbound",
          session_id: meta.session_id,
          peer_id: otherPeerId,
          source_peer_id: meta.peer_id,
          message_type: kind,
        });
        continue;
      }

      peerSocket.send(
        JSON.stringify({
          ...decoded,
          session_id: meta.session_id,
          from_peer_id: meta.peer_id,
        })
      );
      await recordAudit(this.env, {
        event: "message_forwarded",
        session_id: meta.session_id,
        peer_id: otherPeerId,
        source_peer_id: meta.peer_id,
        message_type: kind,
      });
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const meta = ws.deserializeAttachment() as PeerMeta | null;
    if (!meta) return;
    this.peers.delete(meta.peer_id);
    await recordAudit(this.env, {
      event: "peer_disconnected",
      session_id: meta.session_id,
      peer_id: meta.peer_id,
      role: meta.role,
      managed_device: meta.managed_device,
    });
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    const meta = ws.deserializeAttachment() as PeerMeta | null;
    if (!meta) return;
    await recordAudit(this.env, {
      event: "peer_socket_error",
      session_id: meta.session_id,
      peer_id: meta.peer_id,
      role: meta.role,
      managed_device: meta.managed_device,
    });
  }
}
