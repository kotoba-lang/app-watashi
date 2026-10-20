# app-watashi（release / audit）— itonami（dapp）上の分散型設計

状態: 第 1 スライス実装（2026-10-20）。正本はこの文書。
追跡: Linear JUN-128（親 JUN-116）。

## 位置づけ

app-watashi は **渡し**（カーソルの渡し舟）—— macOS ↔ Windows の境界を
越えてマウス/キーボードを共有。ハイブリッド構成（Rust native agent = OS 入力 /
WASM = プロトコル協調 / KAMI UI = 設定）。入力共有 = **機微な入力を扱う**ため
監査（E2E 暗号封筒の inner-type）を持つ。

## このスライス: release / audit 判定コア

| 層 | 実体 | 状態 |
|---|---|---|
| 判定コア guest | `aiueos/watashi_release.cljk` — platform-ok（**macos-arm64 / macos-x64 / windows-x64 / linux-x64 の閉じた集合**）/ audit-action-ok（**connect / disconnect / clipboard_read / file_send / screen_capture / config_change の閉じた集合**）/ release-admission（必須 4 つ / invalidPlatform / invalidSizeBytes）/ dedup-take（同一 releaseId は alreadyExists） | **実装済み・実測** |
| 記述子 | `aiueos/watashi-release.edn` | **実装済み** |
| parity | `kotoba/test/watashi/release_parity_test.cljk` — 正本（registry.ts / types.ts）の閉じた集合・拒否名と一致 | **実装済み・実測** |

実測: `amu test aiueos/watashi_release.cljk` → **18/18**（jvm-kir / js / wasm）。
parity → 2 tests / 14 assertions / 0 failures。

## 正本の正確な規則（guest はこれに追従）

- **RELEASE_PLATFORMS** = macos-arm64 / macos-x64 / windows-x64 / linux-x64。
  発行は releaseId / version / blobKey / sha256 の 4 つ必須 + sizeBytes は
  非負整数。同一 releaseId は alreadyExists（冪等）。
- **AUDIT_ACTIONS** = connect / disconnect / clipboard_read / file_send /
  screen_capture / config_change。**clipboard_read / file_send /
  screen_capture は機微な入力を伴う** —— 監査の形も閉じた集合に固定し、
  集合外を記録しない（guest は既定を作らない）。
- audit log は **E2E の暗号封筒の中**（AUDIT_INNER_TYPE）—— 監査内容は
  トランスポート上で平文にしない。

## 未実装境界

- KNP（ChaCha20-Poly1305 + X25519 の暗号化 UDP）と OS 入力注入
  （CGEvent/Win32）は Rust 側 = host。
- peer discovery / DID auth / 画面レイアウトの判定。
- mon（DNA）化、aiueos session 載せ（fleet 共通）。
