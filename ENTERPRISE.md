# Watashi Enterprise Design

`watashi` is currently optimized for local-network input sharing:

- discovery: mDNS (`_watashi._udp.local.`)
- transport: `kami-knp` over encrypted UDP
- pairing: WebAuthn / PIN / QR via control-plane app

That is sufficient for home/LAN use, but it is not sufficient as-is for enterprise environments where:

- Palo Alto GlobalProtect may block or isolate UDP and mDNS
- unsigned Windows executables trigger SmartScreen, AppLocker, WDAC, or EDR policy
- inbound listener ports are not acceptable
- auditability and policy enforcement are required

This document proposes the enterprise architecture, compares Windows distribution options, and defines the recommended implementation order.

## Goal

Make `watashi` usable when one endpoint sits inside a GlobalProtect-protected corporate environment without turning `watashi` into a privileged corporate-data connector.

`watashi` should remain:

- a remote input transport
- a device pairing system
- a policy-aware session relay

It should not become:

- a direct corporate API client
- a VPN bypass
- a generic data exfiltration tool

## Current Constraints

The current implementation and docs establish these boundaries:

- `native/watashi-host/src/discovery.rs`: LAN-only mDNS discovery
- `native/watashi-host/src/net.rs`: encrypted UDP transport through `kami-knp`
- `native/watashi-host/src/main.rs`: server/client/discover/auto modes, default bind `0.0.0.0:4819`
- `appview/.../src/app.ts`: control-plane pairing and release distribution metadata
- `.github/workflows/release.yml`: Windows binary packaging exists, but code-signing is commented out

## Enterprise Architecture

### Separation of Planes

Split the system into 3 explicit planes.

1. Control plane
- Device registration
- Pairing
- Policy distribution
- Session authorization
- Audit event ingestion

2. Data plane
- Input events
- Clipboard events
- Optional file transfer metadata

3. Distribution plane
- Binary delivery
- Integrity verification
- Signing / build provenance

### Transport Modes

Support 3 transport modes in the host.

1. `lan`
- Existing mode
- mDNS + encrypted UDP
- Best latency
- Same subnet / permissive LAN only

2. `direct`
- Manual address or policy-delivered address
- TLS over TCP or WSS over HTTPS
- For routable private networks where direct peer reachability exists

3. `relay`
- Both endpoints make outbound WSS connections to a relay service
- No inbound corporate port opening required
- Best default for GlobalProtect environments

### Recommended Enterprise Topology

Recommended default for corporate environments:

```text
watashi-host (corp laptop)
  outbound WSS/TLS
        |
        v
   watashi-relay
        ^
        |
  outbound WSS/TLS
watashi-host (external device)
```

Current production relay endpoint:

- `https://watashi-relay.etzhayyim.com/relay`

Properties:

- no inbound hole punching required
- survives mDNS isolation
- usually allowed through HTTPS egress controls
- central point for authorization and audit

### Component Responsibilities

#### `watashi-host`

Keep the native binary focused on:

- local input capture / injection
- local screen geometry
- local clipboard access
- transport adapter selection
- policy enforcement received from control plane

Add a transport abstraction:

```rust
trait Transport {
    fn connect(&mut self) -> anyhow::Result<()>;
    fn poll(&mut self) -> Vec<TransportEvent>;
    fn send(&mut self, channel: TransportChannel, payload: Vec<u8>) -> anyhow::Result<()>;
    fn close(&mut self) -> anyhow::Result<()>;
}
```

Implementations:

- `LanUdpTransport`
- `DirectTlsTransport`
- `RelayWssTransport`

#### `watashi-control`

Control-plane responsibilities:

- pair devices
- issue short-lived session tokens
- map peer identity to policy
- mark a device as `corp-managed`, `external`, or `unknown`
- issue session capabilities such as:
  - `allow_input_outbound`
  - `allow_input_inbound`
  - `allow_clipboard_text`
  - `deny_clipboard_file`
  - `allow_file_transfer`
- return launch commands for both peers so enterprise operators can copy/paste:
  - `watashi --relay-host https://watashi-relay.etzhayyim.com/relay --session ... --peer ... --token ...`
  - `watashi --relay-client https://watashi-relay.etzhayyim.com/relay --session ... --peer ... --token ...`

#### `watashi-relay`

Relay responsibilities:

- outbound-only rendezvous
- attach session after token validation
- relay framed input/clipboard/file metadata
- emit audit events
- enforce policy tags from control plane

Relay should not:

- persist clipboard/file bodies longer than needed
- access enterprise APIs
- impersonate a paired device

## Security Model

### Device Identity

Each host should have a durable device identity:

- generated locally on first run
- bound to a public key
- attested to control plane during pairing

Recommended:

- X25519 or Ed25519 device keypair
- short-lived session token minted by control plane
- device certificate or signed device record for managed deployments

### Session Authorization

At session start:

1. host authenticates to control plane
2. control plane returns session token with policy claims
3. host connects to relay using the token
4. relay accepts only matching peer/session IDs

### Directional Policy

Corporate deployments usually need asymmetry.

Examples:

- corp device may receive input from approved peer, but may not send clipboard outward
- corp device may allow text clipboard but deny file clipboard
- corp device may deny external-to-corp file drag-and-drop entirely

### Audit

Emit at least:

- session started / ended
- device paired / unpaired
- clipboard sync attempted / blocked
- file transfer attempted / blocked
- policy deny reason

Do not log raw keystrokes.
Do not log clipboard contents by default.

## Windows EXE Problem in Enterprise Environments

The current Windows packaging path produces a zip containing `watashi.exe`, but the signing step is commented out in `.github/workflows/release.yml`.

That means enterprise failures are likely caused by one or more of:

- Windows SmartScreen reputation failure
- unsigned Authenticode binary blocked by AppLocker / WDAC
- EDR quarantining low-reputation binaries
- firewall prompts for listener mode
- inability to install required runtime dependencies or permissions silently

This is not primarily a source-code problem. It is a trust, packaging, and policy problem.

## Distribution Strategies: 5 Options

### 1. Public prebuilt unsigned `exe`

Flow:

- CI builds `watashi.exe`
- zip is downloaded by user
- user runs binary directly

Pros:

- simplest
- fastest to ship

Cons:

- worst enterprise compatibility
- SmartScreen and reputation failures are expected
- AppLocker / WDAC often block it
- high SOC review overhead

Verdict:

- acceptable for hobby use
- not acceptable as enterprise default

### 2. Public prebuilt signed `exe`

Flow:

- CI builds `watashi.exe`
- SignPath or equivalent Authenticode signs artifact
- signed zip/msi is distributed

Pros:

- strongest standard Windows compatibility
- reduces SmartScreen / EDR friction
- works with enterprise allowlisting processes

Cons:

- requires signing pipeline and certificate governance
- still may be blocked if org only allows approved publishers

Repo status:

- closest to current direction
- `.github/signpath/artifact-configuration.json` already exists
- release workflow has signing step commented out

Verdict:

- best default public distribution path

### 3. Customer-side build from open source

Flow:

- customer clones source
- customer builds `watashi.exe` inside their own environment
- customer signs and deploys internally

Pros:

- strongest trust story for security-conscious enterprises
- compatible with internal signing policies
- avoids low-reputation public binary issue
- easy to review because source is open

Cons:

- higher onboarding friction
- build reproducibility must be documented well
- support burden shifts to build environment differences

Verdict:

- best path for strict enterprises
- should be offered in addition to signed public binaries

### 4. Internal source build plus internal package wrapper

Flow:

- customer builds from source
- packages output as `MSI`, `MSIX`, Intune package, or SCCM package
- internal signing and deployment policy applies

Pros:

- best fit for managed Windows fleets
- supports silent install and rollback
- works with enterprise software distribution tooling

Cons:

- not useful for unmanaged users
- packaging work is required per enterprise

Verdict:

- best managed-fleet option
- better than raw internal `exe` build when IT owns deployment

### 5. Thin trusted bootstrapper + client-side source build

Flow:

- distribute a small reviewed bootstrapper or signed script
- bootstrapper verifies source tag / checksum
- performs local build
- optionally registers resulting binary with internal signing

Pros:

- trust centered on source, not arbitrary binary
- can automate environment setup

Cons:

- still hard in locked-down enterprises
- often blocked by script policy if not signed
- operationally more complex than direct internal build

Verdict:

- niche option
- useful only where scripted local builds are acceptable

## Recommended Distribution Strategy

Use a dual-track model.

### Default

For normal users:

- signed public Windows release
- SignPath or equivalent enabled in CI

### Enterprise

For strict corporate environments:

- customer-side build from source
- optional internal `MSI/MSIX/Intune` packaging

This gives the cleanest story:

- public users get easy installation
- enterprises get internal provenance and publisher trust

## Recommended Priority Order

1. Enable signed Windows release path
2. Add source-build documentation and helper scripts
3. Add relay transport for enterprise networking
4. Add policy-aware clipboard/file controls
5. Add internal-package guidance for customer IT

## Concrete Implementation Plan

### Phase 1: Distribution Hardening

1. Turn signed Windows release into first-class path
- uncomment and complete SignPath workflow path
- release signed `.zip` at minimum
- prefer signed installer later

2. Add reproducible source-build instructions
- pin Rust toolchain
- document required SDK/tools
- publish checksum expectations and build metadata

3. Add enterprise build helper script
- local build
- hash output
- package into zip

### Phase 2: Transport Refactor

Refactor `native/watashi-host/src/net.rs` from concrete KNP wrapper into transport facade.

Suggested file split:

- `src/transport/mod.rs`
- `src/transport/lan_udp.rs`
- `src/transport/direct_tls.rs`
- `src/transport/relay_wss.rs`

Keep event model stable so input pipeline remains unchanged above transport layer.

### Phase 3: Relay

Define minimal relay API:

- `POST /v1/session/token`
- `GET /v1/session/:id`
- `WS /v1/relay?session_id=...&peer_id=...&token=...`

Frame envelope:

```json
{
  "type": "input|clipboard|file-meta|control|audit",
  "channel": "unreliable|reliable-ordered|reliable-unordered",
  "session_id": "sess_...",
  "from_peer_id": "peer_...",
  "seq": 42,
  "payload_b64": "..."
}
```

### Phase 4: Enterprise Policy

Add policy object delivered at session start:

```json
{
  "allow_input_inbound": true,
  "allow_input_outbound": false,
  "allow_clipboard_text": true,
  "allow_clipboard_file": false,
  "allow_file_transfer": false,
  "managed_device": true
}
```

Host enforces locally. Relay enforces centrally.

## Recommendation Summary

### Network

Recommended architecture:

- keep LAN UDP + mDNS for low-latency local use
- add relay-based WSS/TLS mode for enterprise and GlobalProtect environments

### Windows

Recommended distribution:

- public signed binary for standard users
- customer-side build plus internal signing/package path for enterprise users

### What not to do

Do not solve this by adding direct corporate-data access into `watashi`.
Do not rely on UDP-only transport for enterprise networking.
Do not treat unsigned `exe` delivery as an enterprise-ready path.
