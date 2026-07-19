use anyhow::Result;
use kami_bridge::BridgeEvent;
use std::net::SocketAddr;

pub mod direct_tls;
pub mod lan_udp;
pub mod relay_wss;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportMode {
    Lan,
    Direct,
    Relay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportChannel {
    Unreliable,
    ReliableOrdered,
    ReliableUnordered,
    Voice,
}

#[derive(Debug, Clone)]
pub enum TransportEvent {
    PeerConnected { addr: SocketAddr },
    PeerDisconnected { addr: SocketAddr },
    InputEvent { event: BridgeEvent, from: SocketAddr },
    ClipboardText { text: String, from: SocketAddr },
}

pub trait Transport: Send {
    fn connect(&mut self) -> Result<()>;
    fn poll(&mut self) -> Vec<TransportEvent>;
    fn send(&mut self, channel: TransportChannel, payload: Vec<u8>) -> Result<()>;
    fn close(&mut self) -> Result<()>;
}
