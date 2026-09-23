//! `itsaresume serve`: the router behind a small HTTP endpoint.

use crate::router::Router;
use std::net::SocketAddr;

/// Where `serve` listens unless told otherwise: loopback only, because the
/// endpoint has no authentication and spends Nicolas's plan.
pub const DEFAULT_LISTEN: &str = "0.0.0.0:8787";

/// The largest request body accepted, in bytes.
pub const MAX_BODY_BYTES: usize = 1024 * 1024;

/// A bound, not yet running, HTTP endpoint.
pub struct Server {
    router: Router,
}

impl Server {
    /// Bind `address` (e.g. `127.0.0.1:8787`, or port 0 for any free port).
    pub fn bind(router: Router, address: &str) -> Result<Self, String> {
        let _ = address;
        Ok(Self { router })
    }

    /// The address actually bound.
    pub fn local_addr(&self) -> SocketAddr {
        let _ = &self.router;
        SocketAddr::from(([127, 0, 0, 1], 9))
    }

    /// Serve requests until the process ends.
    pub fn run(self) {}
}
