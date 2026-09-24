//! A one-shot HTTP server on 127.0.0.1 that plays LM Studio: it serves one
//! canned response and reports the request it received.

#![allow(dead_code)]

use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::mpsc::{Receiver, channel};
use std::thread;

/// What the fake server received.
pub struct Received {
    pub request_line: String,
    pub headers: Vec<(String, String)>,
    pub body: Value,
}

/// Serve one request with `status` and `body`; return the base URL.
pub fn serve(status: u16, body: &str) -> (String, Receiver<Received>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind a free port");
    let base_url = format!("http://{}/v1", listener.local_addr().expect("address"));
    let body = body.to_owned();
    let (sender, receiver) = channel();
    thread::spawn(move || {
        let (stream, _) = listener.accept().expect("one connection");
        let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
        let mut request_line = String::new();
        reader.read_line(&mut request_line).expect("request line");
        let mut headers = Vec::new();
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).expect("header line");
            let line = line.trim_end();
            if line.is_empty() {
                break;
            }
            let (name, value) = line.split_once(':').expect("a header");
            headers.push((name.trim().to_lowercase(), value.trim().to_owned()));
        }
        let length: usize = headers
            .iter()
            .find(|(name, _)| name == "content-length")
            .map(|(_, value)| value.parse().expect("a length"))
            .unwrap_or(0);
        let mut raw = vec![0; length];
        reader.read_exact(&mut raw).expect("body");
        let _ = sender.send(Received {
            request_line: request_line.trim_end().to_owned(),
            headers,
            body: serde_json::from_slice(&raw).unwrap_or(Value::Null),
        });
        let mut stream = stream;
        let response = format!(
            "HTTP/1.1 {status} Status\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).expect("respond");
    });
    (base_url, receiver)
}
