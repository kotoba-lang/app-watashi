//! mDNS-SD peer discovery for Watashi.
//!
//! Broadcasts and discovers Watashi peers on the local network
//! using DNS-SD (RFC 6763). Service type: `_watashi._udp.local.`

use log::info;
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// mDNS-SD service type for Watashi peer discovery.
const SERVICE_TYPE: &str = "_watashi._udp.local.";

/// Discovered peer from mDNS.
#[derive(Debug, Clone)]
pub struct DiscoveredPeer {
    /// Peer display name.
    pub name: String,
    /// Peer address (IP:port).
    pub addr: SocketAddr,
    /// Platform (macos/windows/linux).
    pub platform: String,
    /// Number of screens.
    pub screen_count: u32,
}

/// mDNS peer discovery service.
pub struct Discovery {
    daemon: ServiceDaemon,
    peers: Arc<Mutex<HashMap<String, DiscoveredPeer>>>,
}

impl Discovery {
    /// Create a new discovery service.
    pub fn new() -> anyhow::Result<Self> {
        let daemon = ServiceDaemon::new()?;
        Ok(Self {
            daemon,
            peers: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// Register this machine as a Watashi peer on the local network.
    pub fn register(
        &self,
        name: &str,
        port: u16,
        platform: &str,
        screen_count: u32,
    ) -> anyhow::Result<()> {
        let hostname = hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "watashi".into());

        let instance_name = format!("{name} ({hostname})");

        let mut properties = HashMap::new();
        properties.insert("platform".to_string(), platform.to_string());
        properties.insert("screens".to_string(), screen_count.to_string());
        properties.insert("version".to_string(), env!("CARGO_PKG_VERSION").to_string());

        let service = ServiceInfo::new(
            SERVICE_TYPE,
            &instance_name,
            &format!("{hostname}.local."),
            "",
            port,
            properties,
        )?;

        self.daemon.register(service)?;
        info!("mDNS: registered as '{instance_name}' on port {port}");
        Ok(())
    }

    /// Start browsing for Watashi peers on the network.
    /// Returns immediately; discovered peers are stored internally.
    pub fn start_browsing(&self) -> anyhow::Result<()> {
        let receiver = self.daemon.browse(SERVICE_TYPE)?;
        let peers = Arc::clone(&self.peers);

        std::thread::spawn(move || {
            while let Ok(event) = receiver.recv() {
                match event {
                    ServiceEvent::ServiceResolved(info) => {
                        let name = info.get_fullname().to_string();
                        let port = info.get_port();
                        let platform = info
                            .get_properties()
                            .get("platform")
                            .map(|v| v.val_str().to_string())
                            .unwrap_or_default();
                        let screen_count: u32 = info
                            .get_properties()
                            .get("screens")
                            .and_then(|v| v.val_str().parse().ok())
                            .unwrap_or(1);

                        for addr in info.get_addresses() {
                            let socket_addr = SocketAddr::new(*addr, port);
                            let peer = DiscoveredPeer {
                                name: info.get_fullname().to_string(),
                                addr: socket_addr,
                                platform: platform.clone(),
                                screen_count,
                            };
                            info!("mDNS: discovered peer '{}' at {socket_addr} ({platform})", peer.name);
                            peers.lock().unwrap().insert(name.clone(), peer);
                        }
                    }
                    ServiceEvent::ServiceRemoved(_type, fullname) => {
                        info!("mDNS: peer removed '{fullname}'");
                        peers.lock().unwrap().remove(&fullname);
                    }
                    ServiceEvent::SearchStarted(_) => {
                        info!("mDNS: browsing for peers on LAN...");
                    }
                    _ => {}
                }
            }
        });

        Ok(())
    }

    /// Get currently discovered peers.
    pub fn peers(&self) -> Vec<DiscoveredPeer> {
        self.peers.lock().unwrap().values().cloned().collect()
    }

    /// Wait for at least one peer to be discovered, with timeout.
    pub fn wait_for_peer(&self, timeout: Duration) -> Option<DiscoveredPeer> {
        let start = std::time::Instant::now();
        loop {
            let peers = self.peers();
            if let Some(peer) = peers.into_iter().next() {
                return Some(peer);
            }
            if start.elapsed() >= timeout {
                return None;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    /// Unregister and shut down.
    pub fn shutdown(self) -> anyhow::Result<()> {
        self.daemon.shutdown()?;
        Ok(())
    }
}
