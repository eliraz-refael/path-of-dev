//! `pathofdev watch`: the Path of Dev game in a terminal pane beside Claude Code, read from the game server's stream.
//!
//! ```text
//! ui thread       crossterm's poll (250 ms) for keys and resizes; drains the stream's updates; draws on a change
//!   ◀── mpsc ──   stream thread: the snapshot, then GET /v1/stream?after=cursor in a loop (stream.rs)
//!                 channel thread: tiny_http on watch.sock, where the mod's hello will land (channel.rs)
//! ```

pub mod channel;
pub mod cli;
pub mod client;
pub mod stream;
pub mod ui;
pub mod watch;
pub mod wire;
