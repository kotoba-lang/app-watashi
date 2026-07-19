/// Build script — embed build metadata + Windows manifest.
fn main() {
    // ── Build metadata (all platforms) ──
    emit_build_metadata();

    // ── Windows manifest + version info ──
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os == "windows" {
        embed_windows_manifest();
    }
}

/// Emit compile-time constants: git hash, build date, target triple, rustc version.
fn emit_build_metadata() {
    // Git commit hash
    let git_hash = std::process::Command::new("git")
        .args(["rev-parse", "--short=8", "HEAD"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=WATASHI_GIT_HASH={git_hash}");

    // Git dirty flag
    let dirty = std::process::Command::new("git")
        .args(["diff", "--quiet", "HEAD"])
        .status()
        .map(|s| !s.success())
        .unwrap_or(false);
    println!("cargo:rustc-env=WATASHI_GIT_DIRTY={}", if dirty { "+dirty" } else { "" });

    // Build timestamp (ISO 8601)
    let build_date = std::process::Command::new("date")
        .args(["-u", "+%Y-%m-%dT%H:%M:%SZ"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=WATASHI_BUILD_DATE={build_date}");

    // Target triple
    let target = std::env::var("TARGET").unwrap_or_else(|_| "unknown".into());
    println!("cargo:rustc-env=WATASHI_TARGET={target}");

    // Rustc version
    let rustc_ver = std::process::Command::new("rustc")
        .args(["--version"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=WATASHI_RUSTC={rustc_ver}");

    // Profile (debug/release)
    let profile = std::env::var("PROFILE").unwrap_or_else(|_| "unknown".into());
    println!("cargo:rustc-env=WATASHI_PROFILE={profile}");

    println!("cargo:rerun-if-changed=.git/HEAD");
}

/// Use windres (mingw) to compile .rc → .res and link into the exe.
fn embed_windows_manifest() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let out_dir = std::env::var("OUT_DIR").unwrap();
    let rc_path = format!("{manifest_dir}/watashi.rc");
    let res_path = format!("{out_dir}/watashi.res");

    let windres = std::env::var("WINDRES")
        .unwrap_or_else(|_| "x86_64-w64-mingw32-windres".to_string());

    let status = std::process::Command::new(&windres)
        .args(["--input", &rc_path, "--output", &res_path, "--output-format=coff"])
        .current_dir(&manifest_dir)
        .status();

    match status {
        Ok(s) if s.success() => {
            println!("cargo:rustc-link-arg-bins={res_path}");
            println!("cargo:rerun-if-changed=watashi.rc");
            println!("cargo:rerun-if-changed=watashi.manifest");
        }
        _ => {
            eprintln!("warning: windres not available, skipping manifest embedding");
        }
    }
}
