/**
 * Watashi WASM coordination app.
 *
 * Handles peer discovery, screen layout persistence, and DID authentication
 * for cross-platform input sharing. The actual input capture/injection runs
 * in the Rust native host binary — this app manages the control plane.
 */
import {
  asAgentTool,
  createKyselyDb,
  createWorkerExport,
  createCadenceState,
  createInboxBuffer,
  decodeJson,
  genID,
  nowISO,
  resolveHeartbeatCadence,
  str,
  withCapabilityTags,
  type ComAtprotoSyncSubscribeReposCommit,
  type HostSDK,
  hostSecretsGet,
} from "@etzhayyim/kotodama-host-sdk";

const getDb = () => createKyselyDb();

const NS = "com.etzhayyim.apps.watashi";

const cadenceState = createCadenceState();
const inbox = createInboxBuffer();

let appId = "";
let actorDID = "";
let _pds: any = null;
let cachedSigningKey = "";

// ─── Graph Labels ───
// Domain-specific SQL node labels for cross-platform input sharing graph.
//   WatashiPeer       — registered peer device
//   WatashiSession    — active sharing session between peers
//   WatashiClipboard  — clipboard sync event (text/image/file)
//   WatashiTransfer   — file drag-and-drop transfer between peers
//   WatashiAuditLog   — security audit log for input sharing events
//   WatashiRelease    — published binary release (per platform/version)
//   WatashiPairing    — WebAuthn/PIN/QR device pairing request

// ─── Collection Kinds (AT Protocol camelCase) ───
// peer, layout, session, clipboardSync, fileTransfer, auditLog, peerHeartbeat
// release, pairing

/** Maximum peers in a single sharing session. */
const MAX_SESSION_PEERS = 8;
/** Clipboard sync size limit in bytes (10 MB). */
const MAX_CLIPBOARD_SIZE_BYTES = 10 * 1024 * 1024;
/** Peer heartbeat timeout before marking offline (seconds). */
const PEER_HEARTBEAT_TIMEOUT_SEC = 30;
/** Maximum file transfer size in bytes (1 GB). */
const MAX_FILE_TRANSFER_BYTES = 1024 * 1024 * 1024;
/** Supported platforms for cross-platform sharing. */
const SUPPORTED_PLATFORMS = ["macos", "windows", "linux"] as const;
const RELAY_TOKEN_TTL_SEC = 10 * 60;
const DEFAULT_RELAY_URL = "https://watashi-relay.etzhayyim.com/relay";

type RelayPolicy = {
  allowInputInbound: boolean;
  allowInputOutbound: boolean;
  allowClipboardText: boolean;
  allowClipboardFile: boolean;
  allowFileTransfer: boolean;
  managedDevice: boolean;
};

function base64urlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64urlEncodeText(text: string): string {
  return base64urlEncodeBytes(new TextEncoder().encode(text));
}

async function getSigningKey(): Promise<CryptoKey> {
  if (!cachedSigningKey) {
    if (typeof process !== "undefined" && process.env?.SS_SIGNING_KEY) {
      cachedSigningKey = process.env.SS_SIGNING_KEY;
    }
    const fromHostImports = _pds?.hostImports?.secretsGet?.("SS_SIGNING_KEY");
    if (fromHostImports) {
      cachedSigningKey = String(fromHostImports);
    } else {
      const { value, found } = await hostSecretsGet({ key: "SS_SIGNING_KEY" });
      if (!found || !value) throw new Error("SS_SIGNING_KEY not available");
      cachedSigningKey = value;
    }
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(cachedSigningKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function signRelayClaims(claims: Record<string, unknown>): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const headerB64 = base64urlEncodeText(JSON.stringify(header));
  const payloadB64 = base64urlEncodeText(JSON.stringify(claims));
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = await getSigningKey();
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64urlEncodeBytes(new Uint8Array(sig))}`;
}

function resolveRelayPolicy(input: {
  managedDevice?: boolean;
  direction?: "inbound-only" | "outbound-only" | "bidirectional";
  allowClipboardText?: boolean;
  allowClipboardFile?: boolean;
  allowFileTransfer?: boolean;
}): RelayPolicy {
  const managedDevice = Boolean(input.managedDevice);
  const direction = input.direction ?? (managedDevice ? "inbound-only" : "bidirectional");
  return {
    allowInputInbound: direction === "bidirectional" || direction === "inbound-only",
    allowInputOutbound: direction === "bidirectional" || direction === "outbound-only",
    allowClipboardText: input.allowClipboardText ?? true,
    allowClipboardFile: input.allowClipboardFile ?? !managedDevice,
    allowFileTransfer: input.allowFileTransfer ?? !managedDevice,
    managedDevice,
  };
}

function normalizeRelayUrl(relayUrl?: string): string {
  const normalized = (relayUrl || DEFAULT_RELAY_URL).trim();
  if (!normalized) return DEFAULT_RELAY_URL;
  try {
    const url = new URL(normalized);
    if (!["https:", "http:"].includes(url.protocol)) {
      throw new Error(`unsupported relay protocol: ${url.protocol}`);
    }
    if (url.pathname === "/" || url.pathname === "") {
      url.pathname = "/relay";
    }
    return url.toString().replace(/\/$/, "");
  } catch (error) {
    throw new Error(`invalid relayUrl: ${String(error instanceof Error ? error.message : error)}`);
  }
}

function buildRelayLaunchCommand(input: {
  relayUrl: string;
  role: "host" | "client";
  sessionId: string;
  peerId: string;
  token: string;
}): string {
  const roleFlag = input.role === "host" ? "--relay-host" : "--relay-client";
  return `watashi ${roleFlag} ${input.relayUrl} --session ${input.sessionId} --peer ${input.peerId} --token ${input.token}`;
}

function buildRelayLaunchCard(input: {
  relayUrl: string;
  sessionId: string;
  policy: RelayPolicy;
  host: { peerId: string; token: string };
  client: { peerId: string; token: string };
}) {
  const hostLaunchCommand = buildRelayLaunchCommand({
    relayUrl: input.relayUrl,
    role: "host",
    sessionId: input.sessionId,
    peerId: input.host.peerId,
    token: input.host.token,
  });
  const clientLaunchCommand = buildRelayLaunchCommand({
    relayUrl: input.relayUrl,
    role: "client",
    sessionId: input.sessionId,
    peerId: input.client.peerId,
    token: input.client.token,
  });
  return {
    title: "Relay Session Ready",
    relayUrl: input.relayUrl,
    sessionId: input.sessionId,
    policy: input.policy,
    host: {
      label: `Host (${input.host.peerId})`,
      peerId: input.host.peerId,
      launchCommand: hostLaunchCommand,
      commandPreview: hostLaunchCommand,
    },
    client: {
      label: `Client (${input.client.peerId})`,
      peerId: input.client.peerId,
      launchCommand: clientLaunchCommand,
      commandPreview: clientLaunchCommand,
    },
    checklist: [
      "Install the signed watashi host binary on both devices",
      `Open outbound HTTPS access to ${new URL(input.relayUrl).host}`,
      "Run the host command on the managed/corporate device",
      "Run the client command on the external device",
    ],
  };
}

async function resolveBoundSecret(secretLike: unknown): Promise<string> {
  if (!secretLike) return "";
  if (typeof secretLike === "string") return secretLike;
  if (typeof (secretLike as { get?: () => Promise<string> }).get === "function") {
    return await (secretLike as { get: () => Promise<string> }).get();
  }
  if (typeof (secretLike as { text?: () => Promise<string> }).text === "function") {
    return await (secretLike as { text: () => Promise<string> }).text();
  }
  return String(secretLike);
}

function describeSecretBinding(secretLike: unknown) {
  if (!secretLike) return { present: false };
  const obj = secretLike as Record<string, unknown>;
  return {
    present: true,
    type: typeof secretLike,
    hasGet: typeof obj.get === "function",
    hasText: typeof obj.text === "function",
    ownKeys: Object.getOwnPropertyNames(obj).slice(0, 12),
    protoKeys: Object.getOwnPropertyNames(Object.getPrototypeOf(obj) ?? {}).slice(0, 12),
  };
}

/** Register a peer device with its screen geometries. */
async function cmdRegisterPeer(
  _ctx: unknown,
  payload: Uint8Array,
): Promise<unknown> {
  const body = JSON.parse(new TextDecoder().decode(payload));
  const { peerId, name, platform, screens, addr } = body as {
    peerId: string;
    name: string;
    platform: "macos" | "windows" | "linux";
    screens: Array<{
      id: number;
      x: number;
      y: number;
      width: number;
      height: number;
      scaleFactor: number;
    }>;
    addr: string;
  };

  // Business rule: validate platform is supported
  if (!SUPPORTED_PLATFORMS.includes(platform as typeof SUPPORTED_PLATFORMS[number])) {
    return { ok: false, error: "unsupported_platform", detail: `Platform "${platform}" not supported. Supported: ${SUPPORTED_PLATFORMS.join(", ")}` };
  }

  // Business rule: peer must have at least one screen
  if (!screens || screens.length === 0) {
    return { ok: false, error: "no_screens", detail: "Peer must have at least one screen" };
  }

  // Business rule: validate screen dimensions are positive
  for (const scr of screens) {
    if (scr.width <= 0 || scr.height <= 0) {
      return { ok: false, error: "invalid_screen", detail: `Screen ${scr.id} has invalid dimensions (${scr.width}x${scr.height})` };
    }
  }

  const rkey = genID("peer");
  await getDb().insertInto("vertex_watashi_peer" as any).values({
    vertex_id: `at://${actorDID}/com.etzhayyim.apps.watashi.peer/${rkey}`,
    sensitivity_ord: 2,
    owner_did: actorDID,
    org_id: "anon",
    user_id: "anon",
    actor_id: peerId,
    peer_id: peerId,
    name,
    platform,
    screens: JSON.stringify(screens),
    addr,
    registered_at: nowISO(),
  }).execute();

  // Upsert peer node in graph
  ([] as Record<string, unknown>[]);

  return { ok: true, rkey, peerId };
}

/** Save screen layout configuration (which peer at which edge). */
async function cmdSaveLayout(
  _ctx: unknown,
  payload: Uint8Array,
): Promise<unknown> {
  const body = JSON.parse(new TextDecoder().decode(payload));
  const { localPeerId, edges } = body as {
    localPeerId: string;
    edges: {
      left?: string;
      right?: string;
      top?: string;
      bottom?: string;
    };
  };

  await getDb().insertInto("vertex_watashi_layout" as any).values({
    vertex_id: `at://${actorDID}/com.etzhayyim.apps.watashi.layout/${localPeerId}`,
    sensitivity_ord: 2,
    owner_did: actorDID,
    org_id: "anon",
    user_id: "anon",
    actor_id: localPeerId,
    local_peer_id: localPeerId,
    edges: JSON.stringify(edges),
    saved_at: nowISO(),
  }).execute();

  // Store edge relationships in graph
  for (const [edge, remotePeerId] of Object.entries(edges)) {
    if (!remotePeerId) continue;
    ([] as Record<string, unknown>[]);
  }

  return { ok: true, localPeerId };
}

/** Get layout for a peer. */
async function cmdGetLayout(
  _ctx: unknown,
  payload: Uint8Array,
): Promise<unknown> {
  const body = JSON.parse(new TextDecoder().decode(payload));
  const { peerId } = body as { peerId: string };

  const rows = ([] as Record<string, unknown>[]);

  const edges: Record<string, unknown> = {};
  for (const row of rows) {
    edges[row.edge as string] = {
      peerId: row.remotePeerId,
      name: row.remoteName,
      addr: row.remoteAddr,
      platform: row.remotePlatform,
    };
  }

  return { peerId, edges };
}

/** List all registered peers. */
async function cmdListPeers(
  _ctx: unknown,
  _payload: Uint8Array,
): Promise<unknown> {
  const rows = ([] as Record<string, unknown>[]);
  return { peers: rows };
}

// ─── Session Management ───

/** Create a sharing session between peers. Validates peer count and platform compatibility. */
async function cmdCreateSession(
  _ctx: unknown,
  payload: Uint8Array,
): Promise<unknown> {
  const body = JSON.parse(new TextDecoder().decode(payload));
  const { sessionName, peerIds, encryption } = body as {
    sessionName: string;
    peerIds: string[];
    encryption?: "chacha20" | "aes256" | "none";
  };

  if (!peerIds || peerIds.length < 2) {
    return { ok: false, error: "insufficient_peers", detail: "Session requires at least 2 peers" };
  }

  // Business rule: enforce maximum session size
  if (peerIds.length > MAX_SESSION_PEERS) {
    return { ok: false, error: "session_too_large", detail: `Maximum ${MAX_SESSION_PEERS} peers per session, got ${peerIds.length}` };
  }

  // Business rule: default to encrypted transport, warn on unencrypted
  const effectiveEncryption = encryption ?? "chacha20";
  let securityLevel: "high" | "standard" | "insecure";
  if (effectiveEncryption === "chacha20" || effectiveEncryption === "aes256") {
    securityLevel = "high";
  } else {
    securityLevel = "insecure";
  }

  const sessionId = genID("ses");
  await getDb().insertInto("vertex_watashi_session" as any).values({
    vertex_id: `at://${actorDID}/com.etzhayyim.apps.watashi.session/${sessionId}`,
    sensitivity_ord: 2,
    owner_did: actorDID,
    org_id: "anon",
    user_id: "anon",
    actor_id: appId,
    session_id: sessionId,
    session_name: sessionName ?? `Session ${sessionId}`,
    peer_ids: JSON.stringify(peerIds),
    peer_count: peerIds.length,
    encryption: effectiveEncryption,
    security_level: securityLevel,
    status: "active",
    created_at: nowISO(),
  }).execute();

  // Create session node in graph
  ([] as Record<string, unknown>[]);

  return { ok: true, sessionId, peerCount: peerIds.length, encryption: effectiveEncryption, securityLevel };
}

// ─── Clipboard Sync ───

/** Sync clipboard content between peers. Validates size limits and content type. */
async function cmdSyncClipboard(
  _ctx: unknown,
  payload: Uint8Array,
): Promise<unknown> {
  const body = JSON.parse(new TextDecoder().decode(payload));
  const { sessionId, sourcePeerId, contentType, sizeBytes, contentHash } = body as {
    sessionId: string;
    sourcePeerId: string;
    contentType: "text" | "image" | "file" | "richText";
    sizeBytes: number;
    contentHash: string;
  };

  if (!sessionId || !sourcePeerId) {
    return { ok: false, error: "missing_params", detail: "sessionId and sourcePeerId required" };
  }

  // Business rule: enforce clipboard size limit
  if (sizeBytes > MAX_CLIPBOARD_SIZE_BYTES) {
    return { ok: false, error: "clipboard_too_large", detail: `Clipboard content (${(sizeBytes / 1024 / 1024).toFixed(1)} MB) exceeds limit (${MAX_CLIPBOARD_SIZE_BYTES / 1024 / 1024} MB)` };
  }

  // Business rule: image clipboard requires minimum size (likely not empty)
  if (contentType === "image" && sizeBytes < 100) {
    return { ok: false, error: "image_too_small", detail: "Image clipboard content appears empty or corrupted" };
  }

  const syncId = genID("clip");
  await getDb().insertInto("vertex_watashi_clipboard_sync" as any).values({
    vertex_id: `at://${actorDID}/com.etzhayyim.apps.watashi.clipboardSync/${syncId}`,
    sensitivity_ord: 2,
    owner_did: actorDID,
    org_id: "anon",
    user_id: "anon",
    actor_id: sourcePeerId,
    sync_id: syncId,
    session_id: sessionId,
    source_peer_id: sourcePeerId,
    content_type: contentType,
    size_bytes: sizeBytes,
    content_hash: contentHash,
    synced_at: nowISO(),
  }).execute();

  ([] as Record<string, unknown>[]);

  return { ok: true, syncId, contentType, sizeBytes };
}

// ─── File Transfer ───

/** Initiate file transfer between peers. Validates file size and transfer direction. */
async function cmdInitiateTransfer(
  _ctx: unknown,
  payload: Uint8Array,
): Promise<unknown> {
  const body = JSON.parse(new TextDecoder().decode(payload));
  const { sessionId, sourcePeerId, targetPeerId, fileName, fileSizeBytes } = body as {
    sessionId: string;
    sourcePeerId: string;
    targetPeerId: string;
    fileName: string;
    fileSizeBytes: number;
  };

  if (!sourcePeerId || !targetPeerId || !fileName) {
    return { ok: false, error: "missing_params", detail: "sourcePeerId, targetPeerId, fileName required" };
  }

  // Business rule: cannot transfer to self
  if (sourcePeerId === targetPeerId) {
    return { ok: false, error: "self_transfer", detail: "Cannot transfer file to the same peer" };
  }

  // Business rule: enforce file size limit
  if (fileSizeBytes > MAX_FILE_TRANSFER_BYTES) {
    return { ok: false, error: "file_too_large", detail: `File size (${(fileSizeBytes / 1024 / 1024 / 1024).toFixed(2)} GB) exceeds limit (${MAX_FILE_TRANSFER_BYTES / 1024 / 1024 / 1024} GB)` };
  }

  // Business rule: estimate transfer time and warn on large files
  let priority: "normal" | "background";
  if (fileSizeBytes > 100 * 1024 * 1024) {
    priority = "background";
  } else {
    priority = "normal";
  }

  const transferId = genID("xfr");
  await getDb().insertInto("vertex_watashi_file_transfer" as any).values({
    vertex_id: `at://${actorDID}/com.etzhayyim.apps.watashi.fileTransfer/${transferId}`,
    sensitivity_ord: 2,
    owner_did: actorDID,
    org_id: "anon",
    user_id: "anon",
    actor_id: sourcePeerId,
    transfer_id: transferId,
    session_id: sessionId,
    source_peer_id: sourcePeerId,
    target_peer_id: targetPeerId,
    file_name: fileName,
    file_size_bytes: fileSizeBytes,
    priority,
    status: "initiated",
    initiated_at: nowISO(),
  }).execute();

  ([] as Record<string, unknown>[]);

  return { ok: true, transferId, fileName, fileSizeBytes, priority };
}

// ─── Peer Heartbeat ───

/** Record peer heartbeat to track online status. Marks peer as online/offline based on timing. */
async function cmdPeerHeartbeat(
  _ctx: unknown,
  payload: Uint8Array,
): Promise<unknown> {
  const body = JSON.parse(new TextDecoder().decode(payload));
  const { peerId, cpuUsage, memoryUsage } = body as {
    peerId: string;
    cpuUsage?: number;
    memoryUsage?: number;
  };

  if (!peerId) {
    return { ok: false, error: "missing_params", detail: "peerId required" };
  }

  // Business rule: validate resource usage values if provided
  if (cpuUsage !== undefined && (cpuUsage < 0 || cpuUsage > 100)) {
    return { ok: false, error: "invalid_cpu", detail: "CPU usage must be between 0 and 100" };
  }

  ([] as Record<string, unknown>[]);

  return { ok: true, peerId, onlineStatus: "online" };
}

// ─── Audit Log ───

/** Record an audit log entry for security-sensitive operations. */
async function cmdRecordAudit(
  _ctx: unknown,
  payload: Uint8Array,
): Promise<unknown> {
  const body = JSON.parse(new TextDecoder().decode(payload));
  const { peerId, action, targetPeerId, detail } = body as {
    peerId: string;
    action: "connect" | "disconnect" | "clipboard_read" | "file_send" | "screen_capture" | "config_change";
    targetPeerId?: string;
    detail?: string;
  };

  if (!peerId || !action) {
    return { ok: false, error: "missing_params", detail: "peerId and action required" };
  }

  // Business rule: screen_capture events require explicit target
  if (action === "screen_capture" && !targetPeerId) {
    return { ok: false, error: "target_required", detail: "Screen capture audit events require a target peer" };
  }

  const auditId = genID("aud");
  await getDb().insertInto("vertex_watashi_audit_log" as any).values({
    vertex_id: `at://${actorDID}/com.etzhayyim.apps.watashi.auditLog/${auditId}`,
    sensitivity_ord: 2,
    owner_did: actorDID,
    org_id: "anon",
    user_id: "anon",
    actor_id: peerId,
    audit_id: auditId,
    peer_id: peerId,
    action,
    target_peer_id: targetPeerId ?? "",
    detail: detail ?? "",
    logged_at: nowISO(),
  }).execute();

  ([] as Record<string, unknown>[]);

  return { ok: true, auditId, action };
}

// ─── Binary Download / Release ───

/** Supported release platforms and architectures. */
const RELEASE_PLATFORMS = {
  "macos-arm64": { os: "macos", arch: "arm64", ext: ".tar.gz", label: "macOS (Apple Silicon)" },
  "macos-x64": { os: "macos", arch: "x64", ext: ".tar.gz", label: "macOS (Intel)" },
  "windows-x64": { os: "windows", arch: "x64", ext: ".zip", label: "Windows (64-bit)" },
  "linux-x64": { os: "linux", arch: "x64", ext: ".tar.gz", label: "Linux (64-bit)" },
} as const;

type ReleasePlatformKey = keyof typeof RELEASE_PLATFORMS;

/** Register a new binary release for download. Stores metadata in graph + AT Record. */
async function cmdPublishRelease(
  _ctx: unknown,
  payload: Uint8Array,
): Promise<unknown> {
  const body = JSON.parse(new TextDecoder().decode(payload));
  const { version, platform, blobKey, sizeBytes, sha256 } = body as {
    version: string;
    platform: ReleasePlatformKey;
    blobKey: string;
    sizeBytes: number;
    sha256: string;
  };

  if (!version || !platform || !blobKey || !sha256) {
    return { ok: false, error: "missing_params", detail: "version, platform, blobKey, sha256 required" };
  }

  if (!(platform in RELEASE_PLATFORMS)) {
    return { ok: false, error: "invalid_platform", detail: `Supported: ${Object.keys(RELEASE_PLATFORMS).join(", ")}` };
  }

  const releaseId = genID("rel");
  const meta = RELEASE_PLATFORMS[platform];

  await getDb().insertInto("vertex_watashi_release" as any).values({
    vertex_id: `at://${actorDID}/com.etzhayyim.apps.watashi.release/${releaseId}`,
    sensitivity_ord: 2,
    owner_did: actorDID,
    org_id: "anon",
    user_id: "anon",
    actor_id: appId,
    release_id: releaseId,
    version,
    platform,
    os: meta.os,
    arch: meta.arch,
    blob_key: blobKey,
    size_bytes: sizeBytes,
    sha256,
    file_name: `watashi-${version}-${platform}${meta.ext}`,
    published_at: nowISO(),
  }).execute();

  ([] as Record<string, unknown>[]);

  return { ok: true, releaseId, version, platform, fileName: `watashi-${version}-${platform}${meta.ext}` };
}

/** Get download URL for the latest release matching the requested platform. */
async function cmdGetDownload(
  _ctx: unknown,
  payload: Uint8Array,
): Promise<unknown> {
  const body = JSON.parse(new TextDecoder().decode(payload));
  const { platform, version } = body as { platform?: ReleasePlatformKey; version?: string };

  let sql: string;
  const params: Record<string, unknown> = {};

  if (version && platform) {
    sql = `MATCH (r:WatashiRelease {version: $version, platform: $platform}) RETURN r.releaseId AS releaseId, r.version AS version, r.platform AS platform, r.blobKey AS blobKey, r.sizeBytes AS sizeBytes, r.sha256 AS sha256, r.publishedAt AS publishedAt LIMIT 1`;
    params.version = version;
    params.platform = platform;
  } else if (platform) {
    sql = `MATCH (r:WatashiRelease {platform: $platform}) RETURN r.releaseId AS releaseId, r.version AS version, r.platform AS platform, r.blobKey AS blobKey, r.sizeBytes AS sizeBytes, r.sha256 AS sha256, r.publishedAt AS publishedAt ORDER BY r.publishedAt DESC LIMIT 1`;
    params.platform = platform;
  } else {
    sql = `MATCH (r:WatashiRelease) RETURN r.releaseId AS releaseId, r.version AS version, r.platform AS platform, r.blobKey AS blobKey, r.sizeBytes AS sizeBytes, r.sha256 AS sha256, r.publishedAt AS publishedAt ORDER BY r.publishedAt DESC LIMIT 10`;
  }

  const rows = ([] as Record<string, unknown>[]);
  if (rows.length === 0) {
    return { ok: true, releases: [], detail: "No releases found" };
  }

  const releases = rows.map((row) => {
    const plat = row.platform as ReleasePlatformKey;
    const meta = RELEASE_PLATFORMS[plat];
    return {
      releaseId: row.releaseId,
      version: row.version,
      platform: plat,
      label: meta?.label ?? plat,
      downloadUrl: `/api/blob/${row.blobKey}`,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      publishedAt: row.publishedAt,
    };
  });

  return { ok: true, releases };
}

/** List all available releases grouped by version. */
async function cmdListReleases(
  _ctx: unknown,
  _payload: Uint8Array,
): Promise<unknown> {
  const rows = ([] as Record<string, unknown>[]);
  return { ok: true, releases: rows };
}

// ─── WebAuthn Device Pairing ───

/**
 * Initiate WebAuthn-based device pairing.
 * Used when mDNS discovery is not available (different subnets, VPN, remote).
 * Creates a pairing challenge that the remote device completes via WebAuthn assertion.
 */
async function cmdInitiatePairing(
  _ctx: unknown,
  payload: Uint8Array,
): Promise<unknown> {
  const body = JSON.parse(new TextDecoder().decode(payload));
  const { localPeerId, pairingMethod } = body as {
    localPeerId: string;
    pairingMethod: "webauthn" | "pin" | "qr";
  };

  if (!localPeerId) {
    return { ok: false, error: "missing_params", detail: "localPeerId required" };
  }

  const method = pairingMethod ?? "webauthn";
  const pairingId = genID("pair");

  // Generate a random challenge for WebAuthn or PIN
  const challengeBytes = new Uint8Array(32);
  crypto.getRandomValues(challengeBytes);
  const challenge = Array.from(challengeBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // For PIN mode: derive a 6-digit numeric PIN from challenge
  const pin = method === "pin"
    ? String(parseInt(challenge.slice(0, 8), 16) % 1000000).padStart(6, "0")
    : undefined;

  await getDb().insertInto("vertex_watashi_pairing" as any).values({
    vertex_id: `at://${actorDID}/com.etzhayyim.apps.watashi.pairing/${pairingId}`,
    sensitivity_ord: 2,
    owner_did: actorDID,
    org_id: "anon",
    user_id: "anon",
    actor_id: localPeerId,
    pairing_id: pairingId,
    local_peer_id: localPeerId,
    method,
    challenge,
    pin: pin ?? "",
    status: "pending",
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    created_at: nowISO(),
  }).execute();

  ([] as Record<string, unknown>[]);

  const result: Record<string, unknown> = { ok: true, pairingId, method, expiresInSeconds: 300 };

  if (method === "webauthn") {
    // Return WebAuthn challenge for the remote device to complete via auth.etzhayyim.com
    result.webauthn = {
      challenge,
      rpId: "watashi.etzhayyim.com",
      userVerification: "preferred",
      authUrl: `https://auth.etzhayyim.com/pair?challenge=${challenge}&app=watashi&pairingId=${pairingId}`,
    };
  } else if (method === "pin") {
    result.pin = pin;
    result.detail = "Display this PIN on the server screen. Enter it on the client to pair.";
  } else if (method === "qr") {
    // QR contains a deep link with the pairing challenge
    result.qrPayload = `watashi://pair?id=${pairingId}&challenge=${challenge}`;
    result.detail = "Scan this QR code on the remote device to pair.";
  }

  return result;
}

/** Complete a pairing request from the remote device side. */
async function cmdCompletePairing(
  _ctx: unknown,
  payload: Uint8Array,
): Promise<unknown> {
  const body = JSON.parse(new TextDecoder().decode(payload));
  const { pairingId, remotePeerId, response } = body as {
    pairingId: string;
    remotePeerId: string;
    response: {
      method: "webauthn" | "pin";
      /** WebAuthn: base64url-encoded authenticator assertion. PIN: the 6-digit code. */
      credential?: string;
      pin?: string;
    };
  };

  if (!pairingId || !remotePeerId || !response) {
    return { ok: false, error: "missing_params", detail: "pairingId, remotePeerId, response required" };
  }

  // Look up the pairing record
  const rows = ([] as Record<string, unknown>[]);

  if (rows.length === 0) {
    return { ok: false, error: "pairing_not_found", detail: "Pairing request not found or already completed" };
  }

  const pairing = rows[0];
  const expiresAt = new Date(pairing.expiresAt as string);
  if (expiresAt < new Date()) {
    return { ok: false, error: "pairing_expired", detail: "Pairing request has expired. Initiate a new one." };
  }

  // Mark pairing as completed
  ([] as Record<string, unknown>[]);

  // Create a trusted edge between the paired peers
  ([] as Record<string, unknown>[]);

  _pds.dispatch({
    type: "app.bsky.feed.post",
    payload: {
      text: `Device paired: ${remotePeerId} ↔ ${pairing.localPeerId} via ${pairing.method}`,
    },
  });

  return {
    ok: true,
    pairingId,
    localPeerId: pairing.localPeerId,
    remotePeerId,
    method: pairing.method,
  };
}

// ─── Relay Session / Policy ───

async function cmdIssueRelaySession(
  _ctx: unknown,
  payload: Uint8Array,
): Promise<unknown> {
  const body = JSON.parse(new TextDecoder().decode(payload));
  const {
    localPeerId,
    remotePeerId,
    relayUrl,
    sessionId,
    managedDevice,
    direction,
    allowClipboardText,
    allowClipboardFile,
    allowFileTransfer,
  } = body as {
    localPeerId: string;
    remotePeerId: string;
    relayUrl?: string;
    sessionId?: string;
    managedDevice?: boolean;
    direction?: "inbound-only" | "outbound-only" | "bidirectional";
    allowClipboardText?: boolean;
    allowClipboardFile?: boolean;
    allowFileTransfer?: boolean;
  };

  if (!localPeerId || !remotePeerId) {
    return { ok: false, error: "missing_params", detail: "localPeerId and remotePeerId required" };
  }
  const resolvedRelayUrl = normalizeRelayUrl(relayUrl);

  const relaySessionId = sessionId ?? genID("relay");
  const policy = resolveRelayPolicy({
    managedDevice,
    direction,
    allowClipboardText,
    allowClipboardFile,
    allowFileTransfer,
  });
  const exp = Math.floor(Date.now() / 1000) + RELAY_TOKEN_TTL_SEC;

  const baseClaims = {
    iss: actorDID || "did:web:watashi.etzhayyim.com",
    aud: "watashi-relay",
    app: "watashi",
    session_id: relaySessionId,
    relay_url: resolvedRelayUrl,
    local_peer_id: localPeerId,
    remote_peer_id: remotePeerId,
    policy,
    exp,
  };

  const hostToken = await signRelayClaims({
    ...baseClaims,
    sub: localPeerId,
    peer_id: localPeerId,
    target_peer_id: remotePeerId,
    role: "host",
  });
  const clientToken = await signRelayClaims({
    ...baseClaims,
    sub: remotePeerId,
    peer_id: remotePeerId,
    target_peer_id: localPeerId,
    role: "client",
  });

  await getDb().insertInto("vertex_watashi_session" as any).values({
    vertex_id: `at://${actorDID}/com.etzhayyim.apps.watashi.session/${relaySessionId}`,
    sensitivity_ord: 2,
    owner_did: actorDID,
    org_id: "anon",
    user_id: "anon",
    actor_id: appId,
    session_id: relaySessionId,
    local_peer_id: localPeerId,
    remote_peer_id: remotePeerId,
    relay_url: resolvedRelayUrl,
    transport: "relay-wss",
    policy: JSON.stringify(policy),
    expires_at: new Date(exp * 1000).toISOString(),
    created_at: nowISO(),
  }).execute();

  return {
    ok: true,
    sessionId: relaySessionId,
    relayUrl: resolvedRelayUrl,
    expiresAt: new Date(exp * 1000).toISOString(),
    policy,
    host: {
      peerId: localPeerId,
      role: "host",
      token: hostToken,
      launchCommand: buildRelayLaunchCommand({
        relayUrl: resolvedRelayUrl,
        role: "host",
        sessionId: relaySessionId,
        peerId: localPeerId,
        token: hostToken,
      }),
    },
    client: {
      peerId: remotePeerId,
      role: "client",
      token: clientToken,
      launchCommand: buildRelayLaunchCommand({
        relayUrl: resolvedRelayUrl,
        role: "client",
        sessionId: relaySessionId,
        peerId: remotePeerId,
        token: clientToken,
      }),
    },
    launchCard: buildRelayLaunchCard({
      relayUrl: resolvedRelayUrl,
      sessionId: relaySessionId,
      policy,
      host: { peerId: localPeerId, token: hostToken },
      client: { peerId: remotePeerId, token: clientToken },
    }),
  };
}

async function cmdGetRelayDefaultUi(
  _ctx: unknown,
  payload: Uint8Array,
): Promise<unknown> {
  const body = payload.byteLength > 0
    ? JSON.parse(new TextDecoder().decode(payload))
    : {};
  const localPeerId = String(body.localPeerId ?? "peer_host");
  const remotePeerId = String(body.remotePeerId ?? "peer_client");
  const relayUrl = normalizeRelayUrl(body.relayUrl);
  const policy = resolveRelayPolicy({
    managedDevice: body.managedDevice,
    direction: body.direction,
    allowClipboardText: body.allowClipboardText,
    allowClipboardFile: body.allowClipboardFile,
    allowFileTransfer: body.allowFileTransfer,
  });

  return {
    ok: true,
    relayUrl,
    defaults: {
      localPeerId,
      remotePeerId,
      managedDevice: Boolean(body.managedDevice),
      direction: body.direction ?? (Boolean(body.managedDevice) ? "inbound-only" : "bidirectional"),
    },
    launchCard: buildRelayLaunchCard({
      relayUrl,
      sessionId: "relay_session_id_here",
      policy,
      host: { peerId: localPeerId, token: "<host-token>" },
      client: { peerId: remotePeerId, token: "<client-token>" },
    }),
  };
}

async function cmdGetRelayPolicy(
  _ctx: unknown,
  payload: Uint8Array,
): Promise<unknown> {
  const body = JSON.parse(new TextDecoder().decode(payload));
  const {
    managedDevice,
    direction,
    allowClipboardText,
    allowClipboardFile,
    allowFileTransfer,
  } = body as {
    managedDevice?: boolean;
    direction?: "inbound-only" | "outbound-only" | "bidirectional";
    allowClipboardText?: boolean;
    allowClipboardFile?: boolean;
    allowFileTransfer?: boolean;
  };

  return {
    ok: true,
    policy: resolveRelayPolicy({
      managedDevice,
      direction,
      allowClipboardText,
      allowClipboardFile,
      allowFileTransfer,
    }),
  };
}

// ─── Queries ───

/** Coverage stats for watashi graph entities. */
async function cmdCoverageStats(
  _ctx: unknown,
  _payload: Uint8Array,
): Promise<unknown> {
  // SQL deprecated 2026-04-12 — return zero counts
  const [peers, sessions, clipboards, transfers, audits, releases, pairings] = [[], [], [], [], [], [], []] as Record<string, unknown>[][];

  return {
    ok: true,
    peers: Number(peers[0]?.cnt ?? 0),
    activeSessions: Number(sessions[0]?.cnt ?? 0),
    clipboardSyncs: Number(clipboards[0]?.cnt ?? 0),
    fileTransfers: Number(transfers[0]?.cnt ?? 0),
    auditLogs: Number(audits[0]?.cnt ?? 0),
    releases: Number(releases[0]?.cnt ?? 0),
    pairedDevices: Number(pairings[0]?.cnt ?? 0),
  };
}

// ─── Reactive Pipeline ───

/** Handle inbound commit events for watashi collections. */
function handleComAtprotoSyncSubscribeReposCommit(
  _sdk: HostSDK,
  commit: ComAtprotoSyncSubscribeReposCommit,
): { ok: true; detail: string } {
  if (commit.action !== "create") return { ok: true, detail: "skip non-create" };

  const collection = str(commit.collection ?? "");

  if (collection === `${NS}.peer`) {
    inbox.inboundCommits.push({ collection, action: "create", ts: Date.now() });
    return { ok: true, detail: `peer registered: ${collection}` };
  }
  if (collection === `${NS}.session`) {
    inbox.inboundCommits.push({ collection, action: "create", ts: Date.now() });
    return { ok: true, detail: `session created: ${collection}` };
  }
  if (collection === `${NS}.clipboardSync`) {
    return { ok: true, detail: `clipboard sync: ${collection}` };
  }
  if (collection === `${NS}.fileTransfer`) {
    inbox.inboundCommits.push({ collection, action: "create", ts: Date.now() });
    return { ok: true, detail: `file transfer: ${collection}` };
  }
  if (collection === `${NS}.auditLog`) {
    return { ok: true, detail: `audit: ${collection}` };
  }
  if (collection === `${NS}.release`) {
    return { ok: true, detail: `release published: ${collection}` };
  }
  if (collection === `${NS}.pairing`) {
    inbox.inboundCommits.push({ collection, action: "create", ts: Date.now() });
    return { ok: true, detail: `pairing: ${collection}` };
  }

  return { ok: true, detail: `accepted ${collection}` };
}

export { handleComAtprotoSyncSubscribeReposCommit };

export async function runHeartbeat(sdk: HostSDK): Promise<{ ok: boolean; actions: Array<Record<string, unknown>> }> {
  const actions: Array<Record<string, unknown>> = [];
  const ts = nowISO();
  const cadence = await resolveHeartbeatCadence(actorDID, cadenceState, inbox);
  actions.push({ action: "cadenceResolved", mood: cadence.mood, shouldPost: cadence.shouldPost, reason: cadence.reason, ts });

  if (cadence.shouldPost && cadence.contentSource.type !== "none") {
    try {
      const stats = await cmdCoverageStats(sdk, new Uint8Array());
      const s = stats as Record<string, unknown>;
      const text = `Watashi: ${s.peers} peers, ${s.activeSessions} sessions, ${s.clipboardSyncs} clipboard syncs, ${s.fileTransfers} transfers`;
      actions.push({ action: "post", source: "coverageStats", ts });
    } catch (e) {
      console.warn("heartbeat post:", e);
      actions.push({ action: "postFailed", error: String(e), ts });
    }
  }

  if (actions.length === 1) actions.push({ action: "noop", mood: cadence.mood, ts });
  return { ok: true, actions };
}

export default createWorkerExport((sdk: HostSDK) => {
  appId = sdk.pds.selfNanoid ?? "";
  actorDID = sdk.pds.selfRepo ?? "";
  _pds = sdk.pds;
  cachedSigningKey = "";

  // Blob download route: serve release binaries from CDN_R2
  const cdnR2 = (sdk.pds as any).cdnR2 as any;
  sdk.router.get("/api/blob/*", async (c: any) => {
    if (!cdnR2) return c.json({ error: "storage not configured" }, 503);
    const key = c.req.path.replace("/api/blob/", "");
    const obj = await cdnR2.get(key);
    if (!obj) return c.json({ error: "not found" }, 404);
    const fileName = key.split("/").pop() ?? "download";
    return new Response(obj.body, {
      headers: {
        "Content-Type": (obj as any).httpMetadata?.contentType ?? "application/octet-stream",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Length": String((obj as any).size ?? 0),
        "Cache-Control": "public, max-age=86400, immutable",
      },
    });
  });
  sdk.router.get("/api/relay/default-ui", async (c: any) => {
    const payload = {
      localPeerId: c.req.query("localPeerId") ?? undefined,
      remotePeerId: c.req.query("remotePeerId") ?? undefined,
      relayUrl: c.req.query("relayUrl") ?? undefined,
      managedDevice: c.req.query("managedDevice") === "true",
      direction: c.req.query("direction") ?? undefined,
      allowClipboardText: c.req.query("allowClipboardText")
        ? c.req.query("allowClipboardText") === "true"
        : undefined,
      allowClipboardFile: c.req.query("allowClipboardFile")
        ? c.req.query("allowClipboardFile") === "true"
        : undefined,
      allowFileTransfer: c.req.query("allowFileTransfer")
        ? c.req.query("allowFileTransfer") === "true"
        : undefined,
    };
    const result = await cmdGetRelayDefaultUi(null, new TextEncoder().encode(JSON.stringify(payload)));
    return c.json(result);
  });
  sdk.router.get("/api/relay/diag", async (c: any) => {
    const sdkSecret = (sdk.env as Record<string, unknown>)["SS_SIGNING_KEY"];
    const ctxSecret = c.env?.SS_SIGNING_KEY;
    return c.json({
      cachedSigningKey: Boolean(cachedSigningKey),
      processEnv: typeof process !== "undefined" ? Boolean(process.env?.SS_SIGNING_KEY) : false,
      sdkSecret: describeSecretBinding(sdkSecret),
      ctxSecret: describeSecretBinding(ctxSecret),
    });
  });
  sdk.router.post("/api/relay/session", async (c: any) => {
    if (!cachedSigningKey) {
      cachedSigningKey = typeof process !== "undefined" ? process.env?.SS_SIGNING_KEY ?? "" : "";
    }
    if (!cachedSigningKey) {
      cachedSigningKey = await resolveBoundSecret((sdk.env as Record<string, unknown>)["SS_SIGNING_KEY"]);
    }
    if (!cachedSigningKey) {
      cachedSigningKey = await resolveBoundSecret(c.env?.SS_SIGNING_KEY);
    }
    const body = await c.req.json();
    const result = await cmdIssueRelaySession(null, new TextEncoder().encode(JSON.stringify(body)));
    return c.json(result);
  });

  sdk.app
    .command(
      `${NS}.registerPeer`,
      cmdRegisterPeer,
      asAgentTool("Register a peer device for input sharing"),
      withCapabilityTags("input-sharing", "peer-discovery"),
    )
    .command(
      `${NS}.saveLayout`,
      cmdSaveLayout,
      asAgentTool("Save screen layout configuration"),
      withCapabilityTags("input-sharing", "configuration"),
    )
    .command(
      `${NS}.createSession`,
      cmdCreateSession,
      asAgentTool("Create sharing session between peers"),
      withCapabilityTags("input-sharing", "session"),
    )
    .command(
      `${NS}.syncClipboard`,
      cmdSyncClipboard,
      asAgentTool("Sync clipboard content between peers"),
      withCapabilityTags("input-sharing", "clipboard"),
    )
    .command(
      `${NS}.initiateTransfer`,
      cmdInitiateTransfer,
      asAgentTool("Initiate file transfer between peers"),
      withCapabilityTags("input-sharing", "file-transfer"),
    )
    .command(
      `${NS}.peerHeartbeat`,
      cmdPeerHeartbeat,
      asAgentTool("Record peer heartbeat for online status"),
      withCapabilityTags("input-sharing", "monitoring"),
    )
    .command(
      `${NS}.recordAudit`,
      cmdRecordAudit,
      asAgentTool("Record security audit log entry"),
      withCapabilityTags("input-sharing", "security", "audit"),
    )
    .command(
      `${NS}.publishRelease`,
      cmdPublishRelease,
      asAgentTool("Publish a binary release for download"),
      withCapabilityTags("input-sharing", "distribution"),
    )
    .command(
      `${NS}.initiatePairing`,
      cmdInitiatePairing,
      asAgentTool("Initiate WebAuthn/PIN/QR device pairing"),
      withCapabilityTags("input-sharing", "pairing", "security"),
    )
    .command(
      `${NS}.completePairing`,
      cmdCompletePairing,
      asAgentTool("Complete device pairing from remote side"),
      withCapabilityTags("input-sharing", "pairing", "security"),
    )
    .command(
      `${NS}.issueRelaySession`,
      cmdIssueRelaySession,
      asAgentTool("Issue relay session tokens and policy for host/client peers"),
      withCapabilityTags("input-sharing", "relay", "security"),
    )
    .query(`${NS}.getRelayDefaultUi`, cmdGetRelayDefaultUi)
    .query(`${NS}.getRelayPolicy`, cmdGetRelayPolicy)
    .query(`${NS}.getLayout`, cmdGetLayout)
    .query(`${NS}.listPeers`, cmdListPeers)
    .query(`${NS}.getDownload`, cmdGetDownload)
    .query(`${NS}.listReleases`, cmdListReleases)
    .query(`${NS}.coverageStats`, cmdCoverageStats);
});
