/**
 * watashi kotoba — kotoba-E2E split for the cross-platform input-sharing
 * coordinator (渡し). Public release catalog plaintext + per-peer security
 * audit log sealed E2E.
 *
 * Per ADR-2606011400 (Consensys) + ADR-2605172400 (3-axis) + ADR-2605181100
 * (kotoba E2E encrypted-record envelope). Founder directive 2026-06-03: PII /
 * CUI / LE may migrate to etzhayyim when made safe via kotoba E2E.
 *
 * SPLIT:
 *   PUBLIC (plaintext AT records) — published binary releases: version /
 *   platform / blobKey / sha256 / sizeBytes. A public distribution catalog with
 *   no subject data. Frontable open metadata via sdk.write / sdk.read.
 *   SENSITIVE / LE (kotoba E2E, com.etzhayyim.encrypted.record) — per-peer
 *   security audit log (who connected, clipboard reads, screen-capture,
 *   file-sends, with peerId + targetPeerId). Behavioral/security surveillance
 *   data — written via sdk.encryptedWrite (read-cap = owner DID), so the
 *   substrate never sees who-did-what in plaintext.
 *
 *   STAYS etzhayyim (consumed via consent-capability, NOT collections) — OS input
 *   capture/injection EXECUTION, encrypted UDP (ChaCha20-Poly1305) transport,
 *   WebAuthn assertion verification + PIN/QR-challenge secret custody (the
 *   pairing act), relay HMAC token signing. Resulting records migrate; the
 *   regulated *acts* stay etzhayyim.
 *
 * AT-Lexicon: no float (sizeBytes is an integer; audit body is strings/enums).
 */

// Plaintext public collection.
export const RELEASE_COLLECTION = "com.etzhayyim.apps.watashi.release";
// E2E inner-type NSID (body shape inside the encrypted envelope).
export const AUDIT_INNER_TYPE = "com.etzhayyim.apps.watashi.auditLog";

export const WATASHI_DID_PREFIX = "did:web:watashi.etzhayyim.com:" as const;

export const RELEASE_PLATFORMS = ["macos-arm64", "macos-x64", "windows-x64", "linux-x64"] as const;
export type ReleasePlatform = (typeof RELEASE_PLATFORMS)[number];

export const AUDIT_ACTIONS = [
  "connect",
  "disconnect",
  "clipboard_read",
  "file_send",
  "screen_capture",
  "config_change",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

// ─── Release (PLAINTEXT, public distribution catalog) ───────────────

export interface ReleaseRecord {
  did: string;
  releaseId: string;
  version: string;
  platform: ReleasePlatform;
  blobKey: string;
  sha256: string;
  sizeBytes: number;
  fileName: string;
  publishedAt: string;
  createdAt: string;
}
export interface ReleaseView extends ReleaseRecord {
  releaseUri: string;
}
export interface PublishReleaseInput {
  releaseId: string;
  version: string;
  platform: ReleasePlatform;
  blobKey: string;
  sha256: string;
  sizeBytes: number;
  publishedAt?: string;
}
export interface PublishReleaseOutput {
  status: "published" | "alreadyExists" | "rejected";
  releaseUri?: string;
  did?: string;
  releaseId?: string;
  error?: string;
}
export interface GetReleaseInput {
  releaseId: string;
}
export interface GetReleaseOutput {
  release?: ReleaseView;
  error?: string;
}
export interface ListReleasesInput {
  platform?: ReleasePlatform;
  limit?: number;
  cursor?: string;
}
export interface ListReleasesOutput {
  items: ReleaseView[];
  cursor?: string;
  total: number;
}

// ─── Audit log (E2E-ENCRYPTED, LE/security) ─────────────────────────

export interface AuditLogBody {
  auditId: string;
  peerId: string;
  action: AuditAction;
  targetPeerId: string;
  detail: string;
  loggedAt: string;
}
export interface AuditLogView extends AuditLogBody {
  uri: string;
  sender: string;
  createdAt: string;
}
export interface RecordAuditInput {
  auditId: string;
  peerId: string;
  action: AuditAction;
  targetPeerId?: string;
  detail?: string;
  loggedAt?: string;
  /** Extra DIDs to grant read-cap (owner always included). */
  recipients?: string[];
}
export interface RecordAuditOutput {
  status: "recorded" | "rejected";
  uri?: string;
  keyId?: string;
  auditId?: string;
  error?: string;
}
export interface ListAuditInput {
  peerId?: string;
  limit?: number;
  cursor?: string;
}
export interface ListAuditOutput {
  items: AuditLogView[];
  cursor?: string;
  total: number;
}
export interface GetAuditInput {
  auditId: string;
}
export interface GetAuditOutput {
  audit?: AuditLogView;
  error?: string;
}

// ─── Coverage rollup ────────────────────────────────────────────────

export interface CoverageInput {
  maxScan?: number;
}
export interface CoverageOutput {
  releaseCount?: number;
  auditLogCount?: number;
  releasesByPlatform?: Record<string, number>;
  truncated?: boolean;
  error?: string;
}

// ─── Validation + helpers ───────────────────────────────────────────

export function isUint(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}
export function isReleasePlatform(p: unknown): p is ReleasePlatform {
  return typeof p === "string" && (RELEASE_PLATFORMS as readonly string[]).includes(p);
}
export function isAuditAction(a: unknown): a is AuditAction {
  return typeof a === "string" && (AUDIT_ACTIONS as readonly string[]).includes(a);
}
export function releaseDidFor(id: string): string {
  return `${WATASHI_DID_PREFIX}rel:${id.toLowerCase()}`;
}
export function releaseRkey(id: string): string {
  return `rel-${id.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}
export function auditRkey(id: string): string {
  return `aud-${id.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}
