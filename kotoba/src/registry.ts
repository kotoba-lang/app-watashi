/**
 * watashi kotoba — kotoba-E2E registry.
 *
 * Plaintext path (release): sdk.write / sdk.read — public distribution catalog.
 * E2E path (auditLog): sdk.encryptedWrite / sdk.encryptedRead — per-peer
 * security audit body sealed in the kotoba envelope (ADR-2605181100), read-cap
 * = owner DID. The substrate never sees who-did-what in plaintext.
 *
 * STAYS etzhayyim (consent-capability): input capture/injection, ChaCha20 UDP
 * transport, WebAuthn/PIN pairing-secret custody, relay HMAC token signing.
 */

import type { Etzhayyim } from "@etzhayyim/sdk";
import {
  AUDIT_INNER_TYPE,
  RELEASE_COLLECTION,
  auditRkey,
  isAuditAction,
  isReleasePlatform,
  isUint,
  releaseDidFor,
  releaseRkey,
  type AuditLogBody,
  type AuditLogView,
  type CoverageInput,
  type CoverageOutput,
  type GetAuditInput,
  type GetAuditOutput,
  type GetReleaseInput,
  type GetReleaseOutput,
  type ListAuditInput,
  type ListAuditOutput,
  type ListReleasesInput,
  type ListReleasesOutput,
  type PublishReleaseInput,
  type PublishReleaseOutput,
  type RecordAuditInput,
  type RecordAuditOutput,
  type ReleaseRecord,
  type ReleaseView,
} from "./types.js";

const PAGE_LIMIT = 100;
const DEFAULT_MAX_SCAN = 10_000;

function releaseFileName(version: string, platform: string): string {
  const ext = platform.startsWith("windows") ? ".zip" : ".tar.gz";
  return `watashi-${version}-${platform}${ext}`;
}

// ─── Release (PLAINTEXT) ────────────────────────────────────────────

export async function publishRelease(e: Etzhayyim, input: PublishReleaseInput): Promise<PublishReleaseOutput> {
  if (!input.releaseId || !input.version || !input.blobKey || !input.sha256) {
    return { status: "rejected", error: "missingRequiredFields" };
  }
  if (!isReleasePlatform(input.platform)) return { status: "rejected", error: "invalidPlatform" };
  if (!isUint(input.sizeBytes)) return { status: "rejected", error: "invalidSizeBytes" };
  const rkey = releaseRkey(input.releaseId);
  const existing = await e.read<ReleaseRecord>({ collection: RELEASE_COLLECTION, rkey }).catch(() => ({ records: [] }));
  if (existing.records[0]?.value) {
    return { status: "alreadyExists", releaseUri: existing.records[0].uri, did: existing.records[0].value.did, releaseId: input.releaseId };
  }
  const now = new Date().toISOString();
  const did = releaseDidFor(input.releaseId);
  const record: ReleaseRecord = {
    did,
    releaseId: input.releaseId,
    version: input.version,
    platform: input.platform,
    blobKey: input.blobKey,
    sha256: input.sha256,
    sizeBytes: input.sizeBytes,
    fileName: releaseFileName(input.version, input.platform),
    publishedAt: input.publishedAt ?? now,
    createdAt: now,
  };
  const receipt = await e.write({ collection: RELEASE_COLLECTION, record: record as unknown as Record<string, unknown>, rkey });
  return { status: "published", releaseUri: receipt.uri, did, releaseId: input.releaseId };
}

export async function getRelease(e: Etzhayyim, input: GetReleaseInput): Promise<GetReleaseOutput> {
  if (!input.releaseId) return { error: "invalidReleaseId" };
  const resp = await e.read<ReleaseRecord>({ collection: RELEASE_COLLECTION, rkey: releaseRkey(input.releaseId) });
  const r = resp.records[0];
  if (!r?.value) return { error: "notFound" };
  return { release: { ...r.value, releaseUri: r.uri } };
}

export async function listReleases(e: Etzhayyim, input: ListReleasesInput = {}): Promise<ListReleasesOutput> {
  const limit = Math.min(input.limit ?? 50, 200);
  const resp = await e.read<ReleaseRecord>({ collection: RELEASE_COLLECTION, cursor: input.cursor, limit });
  const items: ReleaseView[] = resp.records
    .filter((r) => !input.platform || r.value.platform === input.platform)
    .map((r) => ({ ...r.value, releaseUri: r.uri }));
  return { items, cursor: resp.cursor, total: items.length };
}

// ─── Audit log (E2E-ENCRYPTED, LE/security) ─────────────────────────

export async function recordAudit(e: Etzhayyim, input: RecordAuditInput): Promise<RecordAuditOutput> {
  if (!input.auditId || !input.peerId) return { status: "rejected", error: "missingRequiredFields" };
  if (!isAuditAction(input.action)) return { status: "rejected", error: "invalidAction" };
  // Business rule: screen_capture audit events require an explicit target.
  if (input.action === "screen_capture" && !input.targetPeerId) {
    return { status: "rejected", error: "targetRequired" };
  }
  const body: AuditLogBody = {
    auditId: input.auditId,
    peerId: input.peerId,
    action: input.action,
    targetPeerId: input.targetPeerId ?? "",
    detail: input.detail ?? "",
    loggedAt: input.loggedAt ?? new Date().toISOString(),
  };
  // Read-cap = owner DID (sender, auto-wrapped) + any explicit recipients.
  const receipt = await e.encryptedWrite<Record<string, unknown>>({
    innerType: AUDIT_INNER_TYPE,
    record: body as unknown as Record<string, unknown>,
    recipients: input.recipients ?? [],
    rkey: auditRkey(input.auditId),
  });
  return { status: "recorded", uri: receipt.uri, keyId: receipt.keyId, auditId: input.auditId };
}

async function scanAudits(e: Etzhayyim, maxScan: number): Promise<AuditLogView[]> {
  const out: AuditLogView[] = [];
  let cursor: string | undefined;
  while (out.length < maxScan) {
    const page = await e.encryptedRead<AuditLogBody>({ innerType: AUDIT_INNER_TYPE, cursor, limit: PAGE_LIMIT });
    for (const r of page.records) {
      out.push({ ...r.value, uri: r.uri, sender: r.sender, createdAt: r.createdAt });
    }
    if (!page.cursor || page.records.length === 0) break;
    cursor = page.cursor;
  }
  return out;
}

export async function listAudit(e: Etzhayyim, input: ListAuditInput = {}): Promise<ListAuditOutput> {
  const limit = Math.min(input.limit ?? 50, 200);
  const all = await scanAudits(e, DEFAULT_MAX_SCAN);
  const filtered = all.filter((a) => !input.peerId || a.peerId === input.peerId);
  return { items: filtered.slice(0, limit), total: filtered.length };
}

export async function getAudit(e: Etzhayyim, input: GetAuditInput): Promise<GetAuditOutput> {
  if (!input.auditId) return { error: "invalidAuditId" };
  const all = await scanAudits(e, DEFAULT_MAX_SCAN);
  const found = all.find((a) => a.auditId === input.auditId);
  if (!found) return { error: "notFound" };
  return { audit: found };
}

// ─── Coverage rollup ────────────────────────────────────────────────

export async function coverage(e: Etzhayyim, input: CoverageInput = {}): Promise<CoverageOutput> {
  const maxScan = Math.min(input.maxScan ?? DEFAULT_MAX_SCAN, DEFAULT_MAX_SCAN);
  const releasesByPlatform: Record<string, number> = {};
  let releaseCount = 0;
  let cursor: string | undefined;
  while (releaseCount < maxScan) {
    const page = await e.read<ReleaseRecord>({ collection: RELEASE_COLLECTION, cursor, limit: PAGE_LIMIT });
    for (const r of page.records) {
      releasesByPlatform[r.value.platform] = (releasesByPlatform[r.value.platform] ?? 0) + 1;
      releaseCount += 1;
    }
    if (!page.cursor || page.records.length < PAGE_LIMIT) break;
    cursor = page.cursor;
  }
  const auditLogCount = (await scanAudits(e, maxScan)).length;
  return {
    releaseCount,
    auditLogCount,
    releasesByPlatform,
    truncated: releaseCount >= maxScan || auditLogCount >= maxScan,
  };
}
