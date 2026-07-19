//! KAMI-powered GUI for Watashi — live mDNS peer discovery + server status.
//!
//! Nintendo-style wgpu UI via kotodama-kami-host.

use crate::discovery::{Discovery, DiscoveredPeer};
use anyhow::Result;
use kotodama_kami_host::{Color, KamiFrameModel, KamiHostConfig, KamiScene, MeterNode, PanelNode, Rect, TextNode};
use std::sync::{Arc, Mutex};

/// Nintendo-style color palette.
mod palette {
    use super::Color;
    pub const TEAL: Color = Color([0.051, 0.420, 0.365, 1.0]);
    pub const TEAL_LIGHT: Color = Color([0.2, 0.6, 0.5, 1.0]);
    pub const CREAM: Color = Color([0.941, 0.918, 0.839, 1.0]);
    pub const WHITE: Color = Color([1.0, 1.0, 1.0, 1.0]);
    pub const DARK: Color = Color([0.15, 0.15, 0.15, 1.0]);
    pub const GREEN: Color = Color([0.18, 0.8, 0.44, 1.0]);
    pub const PINK: Color = Color([0.957, 0.502, 0.639, 1.0]);
    pub const GRAY: Color = Color([0.5, 0.5, 0.5, 1.0]);
    pub const GRAY_LIGHT: Color = Color([0.7, 0.7, 0.7, 1.0]);
}

/// Build the Watashi status scene.
fn build_scene(
    w: f32,
    h: f32,
    port: u16,
    peers: &[DiscoveredPeer],
    local_screens: usize,
) -> KamiScene {
    let mut panels = Vec::new();
    let mut text = Vec::new();
    let mut meters = Vec::new();
    let card_w = w - 40.0;

    // ─── Title bar ───
    panels.push(PanelNode {
        id: "title-bg".into(),
        rect: Rect { x: 0.0, y: 0.0, width: w, height: 56.0 },
        fill: palette::TEAL,
        border: None, border_width: 0.0, radius: 0.0,
    });
    text.push(TextNode {
        id: "title".into(), content: "Watashi 渡し".into(),
        x: 20.0, y: 16.0, size: 22.0, color: palette::WHITE,
    });
    text.push(TextNode {
        id: "subtitle".into(),
        content: format!("v{} — Cross-Platform Input Sharing", crate::version::VERSION),
        x: w - 310.0, y: 20.0, size: 14.0, color: Color([1.0, 1.0, 1.0, 0.6]),
    });

    // ─── Status card ───
    let cy = 72.0;
    panels.push(PanelNode {
        id: "status-card".into(),
        rect: Rect { x: 20.0, y: cy, width: card_w, height: 90.0 },
        fill: palette::CREAM,
        border: Some(Color([0.0, 0.0, 0.0, 0.05])), border_width: 1.0, radius: 14.0,
    });
    panels.push(PanelNode {
        id: "status-dot".into(),
        rect: Rect { x: 40.0, y: cy + 18.0, width: 14.0, height: 14.0 },
        fill: palette::GREEN,
        border: None, border_width: 0.0, radius: 7.0,
    });
    text.push(TextNode {
        id: "status-mode".into(),
        content: format!("Server — listening on port {port}"),
        x: 62.0, y: cy + 14.0, size: 16.0, color: palette::DARK,
    });
    text.push(TextNode {
        id: "status-screens".into(),
        content: format!("{local_screens} screen(s) detected"),
        x: 62.0, y: cy + 38.0, size: 13.0, color: palette::GRAY,
    });
    text.push(TextNode {
        id: "status-mdns".into(),
        content: "mDNS: broadcasting _watashi._udp.local.".into(),
        x: 62.0, y: cy + 58.0, size: 13.0, color: palette::GRAY,
    });

    // ─── Peers section ───
    let py = cy + 110.0;
    text.push(TextNode {
        id: "peers-title".into(),
        content: format!("Discovered Peers ({})", peers.len()),
        x: 20.0, y: py, size: 16.0, color: palette::DARK,
    });

    if peers.is_empty() {
        panels.push(PanelNode {
            id: "peers-empty".into(),
            rect: Rect { x: 20.0, y: py + 28.0, width: card_w, height: 60.0 },
            fill: palette::CREAM,
            border: Some(Color([0.0, 0.0, 0.0, 0.05])), border_width: 1.0, radius: 14.0,
        });
        text.push(TextNode {
            id: "peers-scan".into(),
            content: "Scanning LAN for other Watashi instances...".into(),
            x: 40.0, y: py + 48.0, size: 14.0, color: palette::GRAY,
        });
        meters.push(MeterNode {
            id: "scan-meter".into(),
            rect: Rect { x: 40.0, y: py + 70.0, width: card_w - 40.0, height: 6.0 },
            value: 0.3, track: Color([0.85, 0.85, 0.85, 1.0]),
            fill: palette::TEAL_LIGHT, radius: 3.0,
        });
    } else {
        for (i, peer) in peers.iter().enumerate() {
            let row_y = py + 28.0 + (i as f32 * 70.0);
            let badge_color = match peer.platform.as_str() {
                "macos" => palette::TEAL_LIGHT,
                "windows" => palette::PINK,
                _ => palette::GRAY_LIGHT,
            };
            panels.push(PanelNode {
                id: format!("peer-{i}"),
                rect: Rect { x: 20.0, y: row_y, width: card_w, height: 58.0 },
                fill: palette::CREAM,
                border: Some(badge_color), border_width: 2.0, radius: 14.0,
            });
            panels.push(PanelNode {
                id: format!("peer-badge-{i}"),
                rect: Rect { x: 36.0, y: row_y + 12.0, width: 70.0, height: 22.0 },
                fill: badge_color,
                border: None, border_width: 0.0, radius: 11.0,
            });
            text.push(TextNode {
                id: format!("peer-plat-{i}"), content: peer.platform.clone(),
                x: 46.0, y: row_y + 14.0, size: 12.0, color: palette::WHITE,
            });
            text.push(TextNode {
                id: format!("peer-name-{i}"), content: peer.name.clone(),
                x: 116.0, y: row_y + 12.0, size: 14.0, color: palette::DARK,
            });
            text.push(TextNode {
                id: format!("peer-addr-{i}"),
                content: format!("{} — {} screen(s)", peer.addr, peer.screen_count),
                x: 116.0, y: row_y + 32.0, size: 12.0, color: palette::GRAY,
            });
        }
    }

    // ─── Bottom bar ───
    let bar_y = h - 40.0;
    panels.push(PanelNode {
        id: "bar".into(),
        rect: Rect { x: 0.0, y: bar_y, width: w, height: 40.0 },
        fill: palette::CREAM,
        border: Some(Color([0.0, 0.0, 0.0, 0.05])), border_width: 1.0, radius: 0.0,
    });
    text.push(TextNode {
        id: "bar-version".into(),
        content: crate::version::short(),
        x: 20.0, y: bar_y + 12.0, size: 12.0, color: palette::GRAY,
    });
    text.push(TextNode {
        id: "bar-enc".into(),
        content: "ChaCha20-Poly1305 encrypted".into(),
        x: w - 220.0, y: bar_y + 12.0, size: 12.0, color: palette::GRAY,
    });

    KamiScene { panels, text, meters }
}

/// Run the Watashi GUI window with live mDNS discovery updates.
pub fn run_ui_with_discovery(mdns: Discovery, port: u16, local_screens: usize) -> Result<()> {
    use kotodama_kami_host::runtime::RenderState;
    use winit::dpi::PhysicalSize;
    use winit::event::{Event, WindowEvent, ElementState, KeyEvent};
    use winit::event_loop::EventLoop;
    use winit::keyboard::{Key, NamedKey};
    use winit::window::WindowBuilder;

    let config = KamiHostConfig {
        app_name: "Watashi 渡し".into(),
        width: 520,
        height: 480,
        runtime_mode: "desktop-wasm-kami-ui".into(),
    };
    let scene = build_scene(config.width as f32, config.height as f32, port, &[], local_screens);
    let frame = KamiFrameModel { config, scene };

    let event_loop = EventLoop::new()?;
    let window = Arc::new(
        WindowBuilder::new()
            .with_title("Watashi 渡し — Cross-Platform Input Sharing")
            .with_inner_size(PhysicalSize::new(frame.config.width, frame.config.height))
            .build(&event_loop)?,
    );
    let mut state = pollster::block_on(RenderState::new(window.clone(), frame))?;

    // Poll mDNS in background
    mdns.start_browsing()?;
    let peers_ref: Arc<Mutex<Vec<DiscoveredPeer>>> = Arc::new(Mutex::new(Vec::new()));
    let peers_bg = Arc::clone(&peers_ref);
    let mdns = Arc::new(mdns);
    let mdns_bg = Arc::clone(&mdns);
    std::thread::spawn(move || loop {
        *peers_bg.lock().unwrap() = mdns_bg.peers();
        std::thread::sleep(std::time::Duration::from_secs(1));
    });

    let mut last_count = 0usize;

    event_loop.run(move |event, elwt| match event {
        Event::WindowEvent { event, window_id } if window_id == window.id() => match event {
            WindowEvent::CloseRequested => elwt.exit(),
            WindowEvent::KeyboardInput {
                event: KeyEvent { logical_key: Key::Named(NamedKey::Escape), state: ElementState::Pressed, .. }, ..
            } => elwt.exit(),
            WindowEvent::Resized(size) => state.resize(size),
            WindowEvent::RedrawRequested => {
                let peers = peers_ref.lock().unwrap().clone();
                if peers.len() != last_count {
                    last_count = peers.len();
                    let s = window.inner_size();
                    state.frame.scene = build_scene(s.width as f32, s.height as f32, port, &peers, local_screens);
                }
                if let Err(e) = state.render() {
                    eprintln!("render error: {e:#}");
                    elwt.exit();
                }
            }
            _ => {}
        },
        Event::AboutToWait => window.request_redraw(),
        _ => {}
    })?;
    Ok(())
}
