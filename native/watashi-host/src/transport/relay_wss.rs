use super::{Transport, TransportChannel, TransportEvent};
use anyhow::{Context, Result};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use kami_bridge::BridgeEvent;
use serde::{Deserialize, Serialize};
use std::io;
use std::net::TcpStream;
use std::time::Duration;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket, connect};
use url::Url;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayRole {
    Host,
    Client,
}

impl RelayRole {
    pub fn as_str(self) -> &'static str {
        match self {
            RelayRole::Host => "host",
            RelayRole::Client => "client",
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct RelayEnvelope {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    channel: String,
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    peer_id: String,
    #[serde(default)]
    role: String,
    #[serde(default)]
    payload_b64: String,
    #[serde(default)]
    clipboard_kind: String,
    #[serde(default)]
    text: String,
}

pub struct RelayWssTransport {
    relay_url: String,
    session_id: String,
    peer_id: String,
    token: String,
    role: RelayRole,
    socket: Option<WebSocket<MaybeTlsStream<TcpStream>>>,
    pending_events: Vec<TransportEvent>,
}

impl RelayWssTransport {
    pub fn new(
        relay_url: impl Into<String>,
        session_id: impl Into<String>,
        peer_id: impl Into<String>,
        token: impl Into<String>,
        role: RelayRole,
    ) -> Self {
        Self {
            relay_url: relay_url.into(),
            session_id: session_id.into(),
            peer_id: peer_id.into(),
            token: token.into(),
            role,
            socket: None,
            pending_events: Vec::new(),
        }
    }

    fn parse_message(message: Message) -> Option<TransportEvent> {
        let text = match message {
            Message::Text(text) => text.to_string(),
            Message::Binary(bytes) => String::from_utf8(bytes.to_vec()).ok()?,
            Message::Close(_) => {
                return Some(TransportEvent::PeerDisconnected {
                    addr: "0.0.0.0:0".parse().unwrap(),
                });
            }
            _ => return None,
        };

        let envelope: RelayEnvelope = serde_json::from_str(&text).ok()?;
        if envelope.kind == "clipboard" && envelope.clipboard_kind == "text" {
            return Some(TransportEvent::ClipboardText {
                text: envelope.text,
                from: "0.0.0.0:0".parse().unwrap(),
            });
        }
        if envelope.kind != "input" {
            return None;
        }
        let payload = BASE64.decode(envelope.payload_b64).ok()?;
        let event = BridgeEvent::from_bytes(&payload)?;
        Some(TransportEvent::InputEvent {
            event,
            from: "0.0.0.0:0".parse().unwrap(),
        })
    }

    fn build_url(&self) -> Result<Url> {
        let mut url = Url::parse(&self.relay_url)
            .with_context(|| format!("invalid relay url: {}", self.relay_url))?;
        url.query_pairs_mut()
            .append_pair("session_id", &self.session_id)
            .append_pair("peer_id", &self.peer_id)
            .append_pair("role", self.role.as_str())
            .append_pair("token", &self.token);
        Ok(url)
    }

    fn configure_socket(socket: &mut WebSocket<MaybeTlsStream<TcpStream>>) -> Result<()> {
        let timeout = Some(Duration::from_millis(1));
        match socket.get_mut() {
            MaybeTlsStream::Plain(stream) => {
                stream.set_read_timeout(timeout)?;
                stream.set_write_timeout(timeout)?;
            }
            MaybeTlsStream::Rustls(stream) => {
                stream.get_mut().set_read_timeout(timeout)?;
                stream.get_mut().set_write_timeout(timeout)?;
            }
            _ => {}
        }
        Ok(())
    }

    pub fn send_clipboard_text(&mut self, text: &str) -> Result<()> {
        let Some(socket) = self.socket.as_mut() else {
            anyhow::bail!("relay websocket is not connected");
        };

        let envelope = RelayEnvelope {
            kind: "clipboard".into(),
            channel: "reliable-ordered".into(),
            session_id: self.session_id.clone(),
            peer_id: self.peer_id.clone(),
            role: self.role.as_str().into(),
            payload_b64: String::new(),
            clipboard_kind: "text".into(),
            text: text.into(),
        };
        socket
            .send(Message::Text(serde_json::to_string(&envelope)?.into()))
            .context("failed to send relay clipboard frame")?;
        Ok(())
    }
}

impl Transport for RelayWssTransport {
    fn connect(&mut self) -> Result<()> {
        let url = self.build_url()?;
        let (mut socket, _) = connect(url.as_str())
            .with_context(|| format!("failed to connect to relay {}", url))?;
        Self::configure_socket(&mut socket)?;
        self.socket = Some(socket);
        self.pending_events.push(TransportEvent::PeerConnected {
            addr: "0.0.0.0:0".parse().unwrap(),
        });
        Ok(())
    }

    fn poll(&mut self) -> Vec<TransportEvent> {
        let mut events = std::mem::take(&mut self.pending_events);
        let Some(socket) = self.socket.as_mut() else {
            return events;
        };

        loop {
            match socket.read() {
                Ok(message) => {
                    if let Some(event) = Self::parse_message(message) {
                        events.push(event);
                    }
                }
                Err(tungstenite::Error::Io(err))
                    if matches!(
                        err.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) =>
                {
                    break;
                }
                Err(tungstenite::Error::ConnectionClosed) => {
                    events.push(TransportEvent::PeerDisconnected {
                        addr: "0.0.0.0:0".parse().unwrap(),
                    });
                    self.socket = None;
                    break;
                }
                Err(_) => break,
            }
        }

        events
    }

    fn send(&mut self, channel: TransportChannel, payload: Vec<u8>) -> Result<()> {
        let Some(socket) = self.socket.as_mut() else {
            anyhow::bail!("relay websocket is not connected");
        };

        let envelope = RelayEnvelope {
            kind: "input".into(),
            channel: match channel {
                TransportChannel::Unreliable => "unreliable".into(),
                TransportChannel::ReliableOrdered => "reliable-ordered".into(),
                TransportChannel::ReliableUnordered => "reliable-unordered".into(),
                TransportChannel::Voice => "voice".into(),
            },
            session_id: self.session_id.clone(),
            peer_id: self.peer_id.clone(),
            role: self.role.as_str().into(),
            payload_b64: BASE64.encode(payload),
            clipboard_kind: String::new(),
            text: String::new(),
        };
        socket
            .send(Message::Text(
                serde_json::to_string(&envelope)?.into(),
            ))
            .context("failed to send relay frame")?;
        Ok(())
    }

    fn close(&mut self) -> Result<()> {
        if let Some(socket) = self.socket.as_mut() {
            let _ = socket.close(None);
        }
        self.socket = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_clipboard_text_frames() {
        let message = Message::Text(
            serde_json::json!({
                "type": "clipboard",
                "clipboard_kind": "text",
                "text": "hello relay"
            })
            .to_string()
            .into(),
        );

        let parsed = RelayWssTransport::parse_message(message);
        match parsed {
            Some(TransportEvent::ClipboardText { text, .. }) => assert_eq!(text, "hello relay"),
            other => panic!("unexpected parsed event: {other:?}"),
        }
    }

    #[test]
    fn parses_input_frames() {
        let event = BridgeEvent::KeyDown {
            keycode: 42,
            modifiers: 1,
        };
        let message = Message::Text(
            serde_json::json!({
                "type": "input",
                "payload_b64": BASE64.encode(event.to_bytes())
            })
            .to_string()
            .into(),
        );

        let parsed = RelayWssTransport::parse_message(message);
        match parsed {
            Some(TransportEvent::InputEvent { event: BridgeEvent::KeyDown { keycode, modifiers }, .. }) => {
                assert_eq!(keycode, 42);
                assert_eq!(modifiers, 1);
            }
            other => panic!("unexpected parsed event: {other:?}"),
        }
    }
}
