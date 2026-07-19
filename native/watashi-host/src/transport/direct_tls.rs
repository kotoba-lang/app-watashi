use super::{Transport, TransportChannel, TransportEvent};
use anyhow::{Result, bail};

pub struct DirectTlsTransport;

impl DirectTlsTransport {
    pub fn new() -> Self {
        Self
    }
}

impl Transport for DirectTlsTransport {
    fn connect(&mut self) -> Result<()> {
        bail!("direct TLS transport is not implemented yet")
    }

    fn poll(&mut self) -> Vec<TransportEvent> {
        Vec::new()
    }

    fn send(&mut self, _channel: TransportChannel, _payload: Vec<u8>) -> Result<()> {
        bail!("direct TLS transport is not implemented yet")
    }

    fn close(&mut self) -> Result<()> {
        Ok(())
    }
}

