/**
 * watashi kotoba — barrel. kotoba-E2E split (plaintext public release catalog +
 * E2E per-peer security audit log, ADR-2605181100). Input capture/injection,
 * ChaCha20 transport, pairing-secret custody, and relay token signing stay etzhayyim
 * via consent-capability; resulting data records migrate here.
 */
export * from "./types.js";
export {
  publishRelease,
  getRelease,
  listReleases,
  recordAudit,
  listAudit,
  getAudit,
  coverage,
} from "./registry.js";
