# Changelog

All notable changes to Watashi (渡し) will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-04-08

### Added
- Rust native binary (macOS arm64 + Windows x64)
- KNP encrypted UDP transport (ChaCha20-Poly1305 + X25519 ECDH)
- 4-channel multiplexing (Unreliable/ReliableOrdered/ReliableUnordered/Voice)
- mDNS auto-discovery (`_watashi._udp.local.`)
- `--server`, `--client`, `--discover`, `--auto` CLI modes
- KAMI Engine GUI (Nintendo-style wgpu, live peer discovery status)
- Screen edge detection + cursor coordinate ratio mapping
- WebAuthn / PIN / QR device pairing (cross-network)
- Clipboard sync (text/image/file, 10 MB limit)
- File transfer (drag-and-drop, 1 GB limit)
- WASM coordination app (AT Protocol peer registry, session management)
- Binary distribution via B2 CDN + download page (mfbtsuyc.etzhayyim.com)
- macOS: .app bundle + Developer ID signing + Apple notarization
- Windows: app manifest (UAC asInvoker, PerMonitorV2 DPI, version info)
- Windows: Authenticode self-signed + DigiCert timestamp
- CycloneDX SBOM (sbom.cdx.json)
- GitHub Actions release CI (macOS arm64/x64 + Windows x64)
- SignPath artifact configuration for future Authenticode signing

### Security
- All network traffic encrypted (ChaCha20-Poly1305, no plaintext option)
- Ephemeral session keys via X25519 ECDH key exchange
- 0-RTT handshake (34-byte client hello, 42-byte server response)
- macOS: hardened runtime + secure timestamp
- Windows: manifest-level UAC (asInvoker, no elevation required at launch)
