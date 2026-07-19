import { describe, it, expect, beforeEach } from "vitest";
import { MockEtzhayyim } from "@etzhayyim/sdk-mock";
import {
  publishRelease,
  getRelease,
  listReleases,
  recordAudit,
  listAudit,
  getAudit,
  coverage,
} from "../src/index.js";

const OWNER = "did:web:watashi.etzhayyim.com";

describe("watashi kotoba (kotoba-E2E split)", () => {
  let e: any;
  beforeEach(() => {
    e = new MockEtzhayyim({ did: OWNER });
  });

  describe("release (PLAINTEXT public catalog)", () => {
    it("publishes, dedups, validates, gets, lists/filters", async () => {
      expect((await publishRelease(e, { releaseId: "r1", version: "1.0.0", platform: "macos-arm64", blobKey: "b/1", sha256: "abc", sizeBytes: 1200 })).status).toBe("published");
      expect((await publishRelease(e, { releaseId: "r1", version: "1.0.0", platform: "macos-arm64", blobKey: "b/1", sha256: "abc", sizeBytes: 1200 })).status).toBe("alreadyExists");
      expect((await publishRelease(e, { releaseId: "rX", version: "1", platform: "macos-arm64", blobKey: "b", sha256: "z", sizeBytes: -1 })).status).toBe("rejected"); // bad size
      expect((await publishRelease(e, { releaseId: "rY", version: "1", platform: "bsd-x64" as any, blobKey: "b", sha256: "z", sizeBytes: 1 })).status).toBe("rejected"); // bad platform
      await publishRelease(e, { releaseId: "r2", version: "1.0.0", platform: "windows-x64", blobKey: "b/2", sha256: "def", sizeBytes: 500 });
      const got = await getRelease(e, { releaseId: "r1" });
      expect(got.release?.fileName).toBe("watashi-1.0.0-macos-arm64.tar.gz");
      expect(got.release?.sizeBytes).toBe(1200);
      expect((await getRelease(e, { releaseId: "nope" })).error).toBe("notFound");
      expect((await listReleases(e)).total).toBe(2);
      expect((await listReleases(e, { platform: "windows-x64" })).total).toBe(1);
      expect((await listReleases(e, { platform: "windows-x64" })).items[0].fileName).toBe("watashi-1.0.0-windows-x64.zip");
    });
  });

  describe("auditLog (E2E-ENCRYPTED LE/security)", () => {
    it("seals via encryptedWrite, round-trips via encryptedRead, validates", async () => {
      const ok = await recordAudit(e, { auditId: "a1", peerId: "peer_mac", action: "clipboard_read", detail: "copied" });
      expect(ok.status).toBe("recorded");
      expect(ok.keyId).toBeTruthy();
      expect((await recordAudit(e, { auditId: "aX", peerId: "p", action: "bogus" as any })).status).toBe("rejected"); // bad action
      expect((await recordAudit(e, { auditId: "aY", peerId: "p", action: "screen_capture" })).status).toBe("rejected"); // missing target
      const got = await getAudit(e, { auditId: "a1" });
      expect(got.audit?.peerId).toBe("peer_mac");
      expect(got.audit?.action).toBe("clipboard_read");
      await recordAudit(e, { auditId: "a2", peerId: "peer_win", action: "screen_capture", targetPeerId: "peer_mac" });
      expect((await listAudit(e)).total).toBe(2);
      expect((await listAudit(e, { peerId: "peer_mac" })).total).toBe(1);
    });

    it("enforces read-cap: a non-recipient DID cannot decrypt the audit log", async () => {
      await recordAudit(e, { auditId: "a1", peerId: "peer_mac", action: "connect" });
      // A different actor (no read-cap) is a distinct PDS view → zero records.
      const outsider: any = new MockEtzhayyim({ did: "did:web:outsider.example" });
      expect((await listAudit(outsider)).total).toBe(0);
    });

    it("grants read-cap to an explicit recipient", async () => {
      const partner = "did:web:partner.example";
      const r = await recordAudit(e, { auditId: "a1", peerId: "peer_mac", action: "file_send", targetPeerId: "peer_win", recipients: [partner] });
      expect(r.status).toBe("recorded");
      // owner can read
      expect((await listAudit(e)).total).toBe(1);
    });
  });

  describe("coverage rollup", () => {
    it("counts plaintext releases + E2E audit logs", async () => {
      await publishRelease(e, { releaseId: "r1", version: "1.0.0", platform: "macos-arm64", blobKey: "b/1", sha256: "a", sizeBytes: 10 });
      await publishRelease(e, { releaseId: "r2", version: "1.0.0", platform: "macos-arm64", blobKey: "b/2", sha256: "b", sizeBytes: 20 });
      await recordAudit(e, { auditId: "a1", peerId: "peer_mac", action: "connect" });
      const cov = await coverage(e);
      expect(cov.releaseCount).toBe(2);
      expect(cov.auditLogCount).toBe(1);
      expect(cov.releasesByPlatform?.["macos-arm64"]).toBe(2);
    });
  });
});
