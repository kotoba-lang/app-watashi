# watashi.etzhayyim.com — 渡し (Cross-Platform Input Sharing)

カーソルの渡し舟。画面の境界を越えて macOS ↔ Windows 間でマウス/キーボードを共有する。

## Architecture

**Hybrid: Rust native agent (OS input) + WASM coordination (protocol) + KAMI Engine UI (config).**

| Layer | Component | Role |
|---|---|---|
| **Data plane** | `kami-bridge` (Rust) | OS input capture/injection (CGEvent/Win32) |
| **Transport** | `kami-knp` (Rust) | Encrypted UDP (ChaCha20-Poly1305, X25519) |
| **Control plane** | WASM App | Peer discovery, screen config, DID auth |
| **UI** | `kami-ui-gpu` + `kotodama-kami-host` | wgpu screen layout config (Nintendo-style) |

### KNP Channel Assignment

| Channel | Usage | Rationale |
|---|---|---|
| `Unreliable` (0) | Mouse movement | 1 frame loss = next overwrites. Latency first |
| `ReliableOrdered` (1) | Key input, mouse click | Order matters (Ctrl+C → V) |
| `ReliableUnordered` (2) | Clipboard sync | Large payload, order irrelevant |
| `Voice` (3) | Reserved (future audio passthrough) | — |

## Peer Discovery

**3 methods (fallback chain): mDNS → WebAuthn/PIN → Manual IP**

| Method | Use Case | Scope |
|---|---|---|
| **mDNS-SD** (`_watashi._udp.local.`) | Same LAN, zero-config | Automatic (default) |
| **WebAuthn / PIN / QR** | Cross-subnet, VPN, remote | Manual initiate via WASM app |
| **Manual IP** | Fallback | `--client <ip:port>` |

### mDNS Auto-Discovery (native)

Server auto-registers on LAN. Client can auto-connect:

```bash
# Server (auto-broadcasts via mDNS)
watashi --server

# Client (auto-discovers server on LAN)
watashi --auto

# List all peers on LAN
watashi --discover
```

### WebAuthn / PIN Pairing (WASM control plane)

For cross-network pairing when mDNS is unavailable:

- `initiatePairing(localPeerId, method: "webauthn" | "pin" | "qr")` — creates 5-min challenge
- `completePairing(pairingId, remotePeerId, response)` — completes from remote side
- WebAuthn delegates to `authn.etzhayyim.com` passkey infrastructure
- PIN: 6-digit code displayed on server, entered on client
- QR: `watashi://pair?id={pairingId}&challenge={challenge}` deep link

## Binary Distribution

Binaries hosted on B2 via `cdn` package. Platform detection + download via WASM app:

- `publishRelease(version, platform, blobKey, sizeBytes, sha256)` — register release
- `getDownload(platform?)` — get latest release URL for platform
- `listReleases()` — all available releases

### Windows Installation

```bash
# 1. Download from watashi.etzhayyim.com (platform auto-detected)
#    or build locally:
cd native/watashi-host
cargo build --release --target x86_64-pc-windows-msvc

# 2. Run (allow through Windows Firewall when prompted)
watashi.exe --auto          # auto-discover server on LAN
watashi.exe --server        # or start as server
watashi.exe --client <ip>   # manual connect

# 3. Firewall: allow UDP port 4819 (KNP encrypted transport)
```

## Directory Structure

```
native/watashi-host/     Rust binary (macOS + Windows + Linux)
  src/main.rs               Entry (server/client/discover/auto/ui modes)
  src/discovery.rs           mDNS-SD peer discovery (mdns-sd crate)
  src/edge.rs               Screen edge detection + cursor transition
  src/net.rs                KNP wrapper (BridgeEvent ↔ wire)
  src/ui.rs                 KAMI config UI (screen layout)
wasm/                       App coordination (peer registry, pairing, downloads)
```

## Build

```bash
# macOS (Apple Silicon)
cd native/watashi-host
cargo build --release

# macOS (Intel)
cargo build --release --target x86_64-apple-darwin

# Windows
cargo build --release --target x86_64-pc-windows-msvc

# Linux
cargo build --release --target x86_64-unknown-linux-gnu
```

## Key Dependencies

- `kami-bridge`: OS input bridge (`40-engine/kami-engine/kami-bridge/`)
- `kami-knp`: Network protocol (`40-engine/kami-engine/kami-knp/`)
- `mdns-sd`: mDNS-SD peer discovery (RFC 6763)
- `kotodama-kami-host`: wgpu desktop host (`40-engine/kotoba/crates/kotoba-kotodama/hosts/kotodama-kami-host/`)
