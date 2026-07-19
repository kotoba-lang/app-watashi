//! Watashi (渡し) native host — cross-platform mouse/keyboard sharing.
//!
//! Cursor ferry between screens. Runs as a system tray/background app
//! on macOS and Windows. Uses kami-bridge for OS input capture/injection,
//! kami-knp for encrypted UDP transport, and kami-ui-gpu for the config UI.

mod discovery;
mod edge;
mod transport;
mod ui;
mod version;

use anyhow::Result;
use kami_bridge::clipboard::{clipboard_get, clipboard_set};
use kami_bridge::{BridgeEvent, ScreenGeometry};
use log::{error, info};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use transport::Transport;
use transport::TransportEvent;
use transport::lan_udp::{LanUdpClientTransport, LanUdpServerTransport, send_bridge_event};
use transport::relay_wss::{RelayRole, RelayWssTransport};

/// Which peer sits at which screen edge.
#[derive(Debug, Clone, Default)]
pub struct PeerLayout {
    pub left: Option<PeerInfo>,
    pub right: Option<PeerInfo>,
    pub top: Option<PeerInfo>,
    pub bottom: Option<PeerInfo>,
}

/// Remote peer connection info.
#[derive(Debug, Clone)]
pub struct PeerInfo {
    pub name: String,
    pub addr: SocketAddr,
    pub screens: Vec<ScreenGeometry>,
}

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    info!("{}", version::oneline());

    let args: Vec<String> = std::env::args().collect();

    match args.get(1).map(|s| s.as_str()) {
        Some("--version") | Some("-V") => {
            println!("{}", version::oneline());
            println!("  build:  {}", version::BUILD_DATE);
            println!("  commit: {}{}", version::GIT_HASH, version::GIT_DIRTY);
            println!("  target: {}", version::TARGET);
            println!("  rustc:  {}", version::RUSTC);
        }
        Some("--server") => run_server(args.get(2))?,
        Some("--client") => {
            let addr = args
                .get(2)
                .expect("usage: watashi --client <server-ip:port>");
            run_client(addr)?;
        }
        Some("--relay-host") => run_relay(&args[2..], RelayRole::Host)?,
        Some("--relay-client") => run_relay(&args[2..], RelayRole::Client)?,
        Some("--discover") => run_discover()?,
        Some("--auto") => run_auto()?,
        Some("--help") | Some("-h") => {
            println!("{}", version::oneline());
            println!();
            println!("Usage:");
            println!("  watashi                         Launch GUI (server + mDNS discovery)");
            println!("  watashi --server [bind-addr]    Headless server (default 0.0.0.0:4819)");
            println!("  watashi --client <addr:port>    Connect to server");
            println!("  watashi --relay-host <url> --session <id> --peer <id> --token <jwt>");
            println!("  watashi --relay-client <url> --session <id> --peer <id> --token <jwt>");
            println!("  watashi --discover              Discover peers on LAN via mDNS");
            println!("  watashi --auto                  Auto-discover and connect (mDNS)");
            println!("  watashi --version               Show version and build info");
            println!("  watashi --help                  Show this help");
        }
        _ => run_gui()?,
    }

    Ok(())
}

/// Run as server (receives connections from clients, exchanges input).
/// Automatically registers on the LAN via mDNS for peer discovery.
fn run_server(bind_addr: Option<&String>) -> Result<()> {
    let addr: SocketAddr = bind_addr
        .map(|s| s.parse())
        .transpose()?
        .unwrap_or_else(|| "0.0.0.0:4819".parse().unwrap());

    info!("starting server on {addr}");

    let bridge = kami_bridge::create_bridge();
    let screens = bridge.screens()?;

    // Register on mDNS for auto-discovery
    let mdns = discovery::Discovery::new()?;
    let platform = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    };
    if let Err(e) = mdns.register("Watashi Server", addr.port(), platform, screens.len() as u32) {
        error!("mDNS registration failed (non-fatal): {e}");
    }
    info!(
        "detected {} screen(s): {:?}",
        screens.len(),
        screens
            .iter()
            .map(|s| format!("{}x{} @({},{})", s.width, s.height, s.x, s.y))
            .collect::<Vec<_>>()
    );

    let forwarding = Arc::new(AtomicBool::new(false));
    let server: Arc<Mutex<Box<dyn Transport>>> =
        Arc::new(Mutex::new(Box::new(LanUdpServerTransport::bind(addr)?)));

    // Start input capture
    let capture_rx = bridge.start_capture()?;
    info!("input capture started");

    // Channel for events received from network
    let (net_inject_tx, net_inject_rx) = mpsc::channel::<BridgeEvent>();

    // Network receive thread
    let server_recv = Arc::clone(&server);
    let forwarding_recv = forwarding.clone();
    std::thread::spawn(move || loop {
        let events = server_recv.lock().unwrap().poll();
        for event in events {
            match event {
                TransportEvent::PeerConnected { addr } => {
                    info!("peer connected: {addr}");
                    forwarding_recv.store(true, Ordering::SeqCst);
                }
                TransportEvent::InputEvent { event, .. } => {
                    let _ = net_inject_tx.send(event);
                }
                TransportEvent::PeerDisconnected { addr } => {
                    info!("peer disconnected: {addr}");
                    forwarding_recv.store(false, Ordering::SeqCst);
                }
                TransportEvent::ClipboardText { .. } => {}
            }
        }
        std::thread::sleep(Duration::from_micros(500));
    });

    // Main input loop
    loop {
        // Check captured local input
        while let Ok(event) = capture_rx.try_recv() {
            if forwarding.load(Ordering::SeqCst) {
                // We're forwarding to remote — send via KNP
                if let Err(e) = send_bridge_event(server.lock().unwrap().as_mut(), &event) {
                    error!("transport send failed: {e}");
                }
            }
        }

        // Inject events received from network
        while let Ok(event) = net_inject_rx.try_recv() {
            if let Err(e) = bridge.inject(&event) {
                error!("inject failed: {e}");
            }
        }

        std::thread::sleep(Duration::from_micros(500));
    }
}

/// Run as client (connects to server).
fn run_client(server_addr: &str) -> Result<()> {
    let addr: SocketAddr = server_addr.parse()?;
    info!("connecting to server at {addr}");

    let bridge = kami_bridge::create_bridge();
    let screens = bridge.screens()?;
    info!("detected {} screen(s)", screens.len());

    let mut client = LanUdpClientTransport::connect_to(addr)?;
    let capture_rx = bridge.start_capture()?;
    let forwarding = Arc::new(AtomicBool::new(false));

    info!("connected, input capture started");

    loop {
        // Send captured local input when forwarding
        while let Ok(event) = capture_rx.try_recv() {
            if forwarding.load(Ordering::SeqCst) {
                if let Err(e) = send_bridge_event(&mut client, &event) {
                    error!("transport send failed: {e}");
                }
            }
        }

        // Receive and inject remote input
        for event in client.poll() {
            match event {
                TransportEvent::InputEvent { event, .. } => {
                    if let Err(e) = bridge.inject(&event) {
                        error!("inject failed: {e}");
                    }
                }
                TransportEvent::PeerConnected { addr } => {
                    info!("connected to server: {addr}");
                    forwarding.store(true, Ordering::SeqCst);
                }
                TransportEvent::PeerDisconnected { addr } => {
                    info!("disconnected from server: {addr}");
                    forwarding.store(false, Ordering::SeqCst);
                }
                TransportEvent::ClipboardText { .. } => {}
            }
        }

        std::thread::sleep(Duration::from_micros(500));
    }
}

fn arg_value<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.windows(2)
        .find(|pair| pair[0] == flag)
        .map(|pair| pair[1].as_str())
}

fn run_relay(args: &[String], role: RelayRole) -> Result<()> {
    let relay_url = args
        .first()
        .map(String::as_str)
        .expect("usage: watashi --relay-host <url> --session <id> --peer <id> --token <jwt>");
    let session_id = arg_value(args, "--session").expect("--session is required");
    let peer_id = arg_value(args, "--peer").expect("--peer is required");
    let token = arg_value(args, "--token").expect("--token is required");

    info!(
        "connecting to relay {} as {} for session {}",
        relay_url,
        role.as_str(),
        session_id
    );

    let bridge = kami_bridge::create_bridge();
    let screens = bridge.screens()?;
    info!("detected {} screen(s)", screens.len());

    let mut transport = RelayWssTransport::new(
        relay_url,
        session_id,
        peer_id,
        token,
        role,
    );
    transport.connect()?;

    let capture_rx = bridge.start_capture()?;
    let forwarding = Arc::new(AtomicBool::new(false));
    let mut last_clipboard_poll = Instant::now();
    let mut last_clipboard_text = clipboard_get().ok();
    let mut clipboard_echo_guard: Option<String> = None;

    loop {
        while let Ok(event) = capture_rx.try_recv() {
            if forwarding.load(Ordering::SeqCst) {
                if let Err(e) = send_bridge_event(&mut transport, &event) {
                    error!("relay send failed: {e}");
                }
            }
        }

        if forwarding.load(Ordering::SeqCst)
            && last_clipboard_poll.elapsed() >= Duration::from_millis(250)
        {
            last_clipboard_poll = Instant::now();
            match clipboard_get() {
                Ok(text) => {
                    if clipboard_echo_guard.as_ref() == Some(&text) {
                        clipboard_echo_guard = None;
                        last_clipboard_text = Some(text);
                    } else if last_clipboard_text.as_ref() != Some(&text) {
                        if let Err(e) = transport.send_clipboard_text(&text) {
                            error!("relay clipboard send failed: {e}");
                        } else {
                            last_clipboard_text = Some(text);
                        }
                    }
                }
                Err(e) => error!("clipboard read failed: {e}"),
            }
        }

        for event in transport.poll() {
            match event {
                TransportEvent::InputEvent { event, .. } => {
                    if let Err(e) = bridge.inject(&event) {
                        error!("inject failed: {e}");
                    }
                }
                TransportEvent::ClipboardText { text, .. } => {
                    if last_clipboard_text.as_ref() == Some(&text) {
                        continue;
                    }
                    if let Err(e) = clipboard_set(&text) {
                        error!("clipboard apply failed: {e}");
                    } else {
                        clipboard_echo_guard = Some(text.clone());
                        last_clipboard_text = Some(text);
                    }
                }
                TransportEvent::PeerConnected { addr } => {
                    info!("relay connected: {addr}");
                    forwarding.store(true, Ordering::SeqCst);
                }
                TransportEvent::PeerDisconnected { addr } => {
                    info!("relay disconnected: {addr}");
                    forwarding.store(false, Ordering::SeqCst);
                }
            }
        }

        std::thread::sleep(Duration::from_micros(500));
    }
}

/// Discover peers on the local network via mDNS-SD.
/// Lists all Watashi instances broadcasting on `_watashi._udp.local.`
fn run_discover() -> Result<()> {
    info!("scanning LAN for Watashi peers (mDNS-SD)...");

    let mdns = discovery::Discovery::new()?;
    mdns.start_browsing()?;

    println!("Scanning for Watashi peers on LAN...");
    println!("(Press Ctrl+C to stop)\n");

    let mut seen = std::collections::HashSet::new();
    loop {
        for peer in mdns.peers() {
            let key = peer.addr.to_string();
            if seen.insert(key) {
                println!(
                    "  Found: {} — {} ({}, {} screen{})",
                    peer.name,
                    peer.addr,
                    peer.platform,
                    peer.screen_count,
                    if peer.screen_count != 1 { "s" } else { "" },
                );
            }
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// Auto-discover a server on LAN via mDNS and connect as client.
fn run_auto() -> Result<()> {
    info!("auto-discovering Watashi server via mDNS...");

    let mdns = discovery::Discovery::new()?;
    mdns.start_browsing()?;

    println!("Searching for Watashi server on LAN...");

    match mdns.wait_for_peer(Duration::from_secs(10)) {
        Some(peer) => {
            println!("Found server: {} at {}", peer.name, peer.addr);
            println!("Connecting...\n");
            let addr_str = peer.addr.to_string();
            run_client(&addr_str)?;
        }
        None => {
            println!("No Watashi server found on LAN after 10 seconds.");
            println!("Make sure a server is running: watashi --server");
            println!("Or connect manually: watashi --client <ip:port>");
        }
    }
    Ok(())
}

/// Launch GUI: mDNS discovery + KAMI status window.
/// Input capture is deferred until a peer connects and sharing is activated.
/// No Input Monitoring permission required at launch.
fn run_gui() -> Result<()> {
    let port = 4819u16;

    info!("launching Watashi GUI (mDNS discovery on port {port})");

    // Detect screens without starting capture (no permission required)
    let screen_count = kami_bridge::create_bridge()
        .screens()
        .map(|s| s.len())
        .unwrap_or(1);
    info!("detected {screen_count} screen(s)");

    // Register on mDNS
    let mdns = discovery::Discovery::new()?;
    let platform = if cfg!(target_os = "macos") { "macos" }
        else if cfg!(target_os = "windows") { "windows" }
        else { "linux" };
    if let Err(e) = mdns.register("Watashi", port, platform, screen_count as u32) {
        error!("mDNS registration failed: {e}");
    }

    // Launch KAMI GUI (blocks until window closes)
    // Server + input capture start when user activates sharing from GUI
    ui::run_ui_with_discovery(mdns, port, screen_count)
}
