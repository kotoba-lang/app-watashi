//! Compile-time build metadata for version display.

/// Semantic version from Cargo.toml.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Short git commit hash (8 chars).
pub const GIT_HASH: &str = env!("WATASHI_GIT_HASH");

/// "+dirty" if uncommitted changes at build time, empty otherwise.
pub const GIT_DIRTY: &str = env!("WATASHI_GIT_DIRTY");

/// Build timestamp (ISO 8601 UTC).
pub const BUILD_DATE: &str = env!("WATASHI_BUILD_DATE");

/// Target triple (e.g. aarch64-apple-darwin, x86_64-pc-windows-gnu).
pub const TARGET: &str = env!("WATASHI_TARGET");

/// Rustc version used for compilation.
pub const RUSTC: &str = env!("WATASHI_RUSTC");

/// Build profile (release/debug).
pub const PROFILE: &str = env!("WATASHI_PROFILE");

/// Full version string: "0.1.0 (abc12345 release aarch64-apple-darwin 2026-04-08T12:00:00Z)"
pub fn full() -> String {
    format!(
        "{VERSION} ({GIT_HASH}{GIT_DIRTY} {PROFILE} {TARGET} {BUILD_DATE})"
    )
}

/// Short version string: "0.1.0+abc12345"
pub fn short() -> String {
    format!("{VERSION}+{GIT_HASH}{GIT_DIRTY}")
}

/// One-line display: "watashi 0.1.0+abc12345 (release, aarch64-apple-darwin)"
pub fn oneline() -> String {
    format!("watashi {VERSION}+{GIT_HASH}{GIT_DIRTY} ({PROFILE}, {TARGET})")
}
