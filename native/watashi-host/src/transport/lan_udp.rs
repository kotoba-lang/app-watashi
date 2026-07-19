use super::{Transport, TransportChannel, TransportEvent};
use anyhow::Result;
use kami_bridge::BridgeEvent;
use kami_knp::client::Client;
use kami_knp::packet::Channel;
use kami_knp::server::Server;
use log::info;
use std::net::SocketAddr;

fn to_knp_channel(channel: TransportChannel) -> Channel {
    match channel {
        TransportChannel::Unreliable => Channel::Unreliable,
        TransportChannel::ReliableOrdered => Channel::ReliableOrdered,
        TransportChannel::ReliableUnordered => Channel::ReliableUnordered,
        TransportChannel::Voice => Channel::Voice,
    }
}

fn channel_for(event: &BridgeEvent) -> TransportChannel {
    match event {
        BridgeEvent::MouseMove { .. } | BridgeEvent::Scroll { .. } => TransportChannel::Unreliable,
        _ => TransportChannel::ReliableOrdered,
    }
}

pub fn send_bridge_event(
    transport: &mut dyn Transport,
    event: &BridgeEvent,
) -> Result<()> {
    let channel = channel_for(event);
    transport.send(channel, event.to_bytes())
}

pub struct LanUdpServerTransport {
    server: Server,
}

impl LanUdpServerTransport {
    pub fn bind(addr: SocketAddr) -> Result<Self> {
        let server = Server::bind(addr)?;
        info!("KNP LAN server bound to {addr}");
        Ok(Self { server })
    }
}

impl Transport for LanUdpServerTransport {
    fn connect(&mut self) -> Result<()> {
        Ok(())
    }

    fn poll(&mut self) -> Vec<TransportEvent> {
        let mut events = Vec::new();
        for server_event in self.server.poll() {
            match server_event {
                kami_knp::server::ServerEvent::ClientConnected { client_id: _, addr } => {
                    events.push(TransportEvent::PeerConnected { addr });
                }
                kami_knp::server::ServerEvent::ClientData {
                    client_id: _,
                    channel: _,
                    payload,
                } => {
                    if let Some(bridge_event) = BridgeEvent::from_bytes(&payload) {
                        events.push(TransportEvent::InputEvent {
                            event: bridge_event,
                            from: "0.0.0.0:0".parse().unwrap(),
                        });
                    }
                }
            }
        }
        events
    }

    fn send(&mut self, channel: TransportChannel, payload: Vec<u8>) -> Result<()> {
        self.server.broadcast(to_knp_channel(channel), payload);
        Ok(())
    }

    fn close(&mut self) -> Result<()> {
        Ok(())
    }
}

pub struct LanUdpClientTransport {
    client: Client,
}

impl LanUdpClientTransport {
    pub fn connect_to(server_addr: SocketAddr) -> Result<Self> {
        let client = Client::connect(server_addr)?;
        info!("KNP LAN client connecting to {server_addr}");
        Ok(Self { client })
    }
}

impl Transport for LanUdpClientTransport {
    fn connect(&mut self) -> Result<()> {
        Ok(())
    }

    fn poll(&mut self) -> Vec<TransportEvent> {
        let mut events = Vec::new();
        for client_event in self.client.poll() {
            match client_event {
                kami_knp::client::ClientEvent::Connected {
                    session_id: _,
                    client_id: _,
                } => {
                    events.push(TransportEvent::PeerConnected {
                        addr: "0.0.0.0:0".parse().unwrap(),
                    });
                }
                kami_knp::client::ClientEvent::Data {
                    channel: _,
                    payload,
                } => {
                    if let Some(bridge_event) = BridgeEvent::from_bytes(&payload) {
                        events.push(TransportEvent::InputEvent {
                            event: bridge_event,
                            from: "0.0.0.0:0".parse().unwrap(),
                        });
                    }
                }
            }
        }
        events
    }

    fn send(&mut self, channel: TransportChannel, payload: Vec<u8>) -> Result<()> {
        self.client.send(to_knp_channel(channel), payload);
        Ok(())
    }

    fn close(&mut self) -> Result<()> {
        Ok(())
    }
}

