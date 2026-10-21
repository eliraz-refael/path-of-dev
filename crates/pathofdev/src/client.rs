//! The companion's one way to the game server: HTTP/1.1 through ureq, to a local server over its Unix socket.
//!
//! ureq speaks HTTP over whatever `Transport` its `Connector` makes, so the socket is a connector of our own, after ureq's
//! `TcpConnector`: it ignores the URL's host (a placeholder, as the mod's `http://pathofdev/…` is) and opens the socket.
//! The traits are in ureq's `unversioned` module, which may change in any release, hence ureq pinned `=3.4.2`.
//!
//!   GET http://pathofdev/v1/… ─▶ FixedResolver (no DNS) ─▶ UnixConnector ─▶ server.sock ─▶ Reply { status, body }
//!                                                                         └─ no socket, refused, timed out ─▶ NoAnswer

use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;
use std::{fmt, net::SocketAddr};

use ureq::Agent;
use ureq::config::Config;
use ureq::http::Uri;
use ureq::unversioned::resolver::{ResolvedSocketAddrs, Resolver};
use ureq::unversioned::transport::{
    Buffers, ConnectionDetails, Connector, LazyBuffers, NextTimeout, Transport,
};

/// What every request names itself as: the server reads it only to tag a presence, which the companion never opens.
pub const CLIENT_HEADER: (&str, &str) = (
    "PathOfDev-Client",
    concat!("watch/", env!("CARGO_PKG_VERSION")),
);

/// Longer than the 25 seconds the server holds a stream poll, so an empty answer always arrives before the timeout.
pub const READ_TIMEOUT: Duration = Duration::from_secs(35);

/// The largest answer read: a snapshot is tens of kilobytes, so this is room, not a limit anyone meets.
const MAX_BODY: u64 = 8 * 1024 * 1024;

/// An answer, whatever its status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reply {
    pub status: u16,
    pub body: String,
    /// The `Retry-After` header, as sent.
    pub retry_after: Option<String>,
}

/// No answer: no socket, nobody listening, or the server went quiet past the timeout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoAnswer(pub String);

/// The local server, at the first of its possible sockets that answers.
pub struct Local {
    /// Where the server may listen, in the mod's order (`socketPathsOf`), each with its own agent.
    sockets: Vec<(PathBuf, Agent)>,
    /// The socket that answered last, tried first.
    last: usize,
}

impl Local {
    pub fn new(paths: Vec<PathBuf>) -> Self {
        let sockets = paths
            .into_iter()
            .map(|path| (path.clone(), agent_for(path)))
            .collect();
        Local { sockets, last: 0 }
    }

    /// `GET path` from the socket that answered last, else from the others in turn.
    pub fn get(&mut self, path: &str) -> Result<Reply, NoAnswer> {
        let count = self.sockets.len();
        let mut failure = NoAnswer("no socket to try".to_owned());
        for offset in 0..count {
            let at = (self.last + offset) % count;
            let (socket, agent) = &self.sockets[at];
            match get(agent, path) {
                Ok(reply) => {
                    self.last = at;
                    return Ok(reply);
                }
                Err(error) => failure = NoAnswer(format!("{}: {}", socket.display(), error.0)),
            }
        }
        Err(failure)
    }
}

fn agent_for(socket: PathBuf) -> Agent {
    let config = Config::builder()
        // A 4xx or 5xx is an answer the stream machine reads, not an error.
        .http_status_as_error(false)
        .timeout_global(Some(READ_TIMEOUT))
        .build();
    Agent::with_parts(config, UnixConnector { socket }, FixedResolver)
}

fn get(agent: &Agent, path: &str) -> Result<Reply, NoAnswer> {
    let url = format!("http://pathofdev{path}");
    let mut response = agent
        .get(&url)
        .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
        .call()
        .map_err(|error| NoAnswer(error.to_string()))?;
    let status = response.status().as_u16();
    let retry_after = response
        .headers()
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let body = response
        .body_mut()
        .with_config()
        .limit(MAX_BODY)
        .read_to_string()
        .map_err(|error| NoAnswer(error.to_string()))?;
    Ok(Reply {
        status,
        body,
        retry_after,
    })
}

/// Hands ureq an address it never uses: the connector below opens the socket whatever the host says.
#[derive(Debug)]
struct FixedResolver;

impl Resolver for FixedResolver {
    fn resolve(
        &self,
        _: &Uri,
        _: &Config,
        _: NextTimeout,
    ) -> Result<ResolvedSocketAddrs, ureq::Error> {
        let mut addrs = self.empty();
        addrs.push(SocketAddr::from(([127, 0, 0, 1], 80)));
        Ok(addrs)
    }
}

/// Opens a Unix socket for every connection, whatever the URL's host.
struct UnixConnector {
    socket: PathBuf,
}

impl fmt::Debug for UnixConnector {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("UnixConnector")
            .field("socket", &self.socket)
            .finish()
    }
}

impl<In: Transport> Connector<In> for UnixConnector {
    type Out = UnixTransport;

    fn connect(
        &self,
        details: &ConnectionDetails,
        _: Option<In>,
    ) -> Result<Option<UnixTransport>, ureq::Error> {
        let stream = UnixStream::connect(&self.socket)?;
        let config = details.config;
        let buffers = LazyBuffers::new(config.input_buffer_size(), config.output_buffer_size());
        Ok(Some(UnixTransport {
            stream,
            buffers,
            read: None,
            write: None,
        }))
    }
}

struct UnixTransport {
    stream: UnixStream,
    buffers: LazyBuffers,
    /// The timeouts last set on the stream, so a syscall is made only when one changes.
    read: Option<Duration>,
    write: Option<Duration>,
}

impl fmt::Debug for UnixTransport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("UnixTransport").finish()
    }
}

/// Sets `timeout` on the stream through `set` when it differs from the one set before.
fn refresh(
    stream: &UnixStream,
    timeout: NextTimeout,
    previous: &mut Option<Duration>,
    set: fn(&UnixStream, Option<Duration>) -> io::Result<()>,
) -> io::Result<()> {
    let wanted = timeout.not_zero().map(|after| *after);
    if wanted != *previous {
        set(stream, wanted)?;
        *previous = wanted;
    }
    Ok(())
}

/// A read or write that timed out is ureq's timeout, named by the deadline that ran out; anything else is I/O.
fn timed(error: io::Error, timeout: NextTimeout) -> ureq::Error {
    match error.kind() {
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock => ureq::Error::Timeout(timeout.reason),
        _ => ureq::Error::Io(error),
    }
}

impl Transport for UnixTransport {
    fn buffers(&mut self) -> &mut dyn Buffers {
        &mut self.buffers
    }

    fn transmit_output(&mut self, amount: usize, timeout: NextTimeout) -> Result<(), ureq::Error> {
        refresh(
            &self.stream,
            timeout,
            &mut self.write,
            UnixStream::set_write_timeout,
        )?;
        let output = &self.buffers.output()[..amount];
        self.stream
            .write_all(output)
            .map_err(|error| timed(error, timeout))
    }

    fn await_input(&mut self, timeout: NextTimeout) -> Result<bool, ureq::Error> {
        refresh(
            &self.stream,
            timeout,
            &mut self.read,
            UnixStream::set_read_timeout,
        )?;
        let input = self.buffers.input_append_buf();
        let amount = self
            .stream
            .read(input)
            .map_err(|error| timed(error, timeout))?;
        self.buffers.input_appended(amount);
        Ok(amount > 0)
    }

    fn is_open(&mut self) -> bool {
        is_open(&mut self.stream)
    }
}

/// Whether a pooled connection can be used again: nothing waiting to be read, and not closed by the server, which a
/// restarted local server does to every connection it had.
fn is_open(stream: &mut UnixStream) -> bool {
    if stream.set_nonblocking(true).is_err() {
        return false;
    }
    let mut byte = [0];
    let quiet =
        matches!(stream.read(&mut byte), Err(error) if error.kind() == io::ErrorKind::WouldBlock);
    stream.set_nonblocking(false).is_ok() && quiet
}

/// The sockets a local server may listen on, as the mod finds them (`socketPathsOf` in `mod/hooks/server.ts`): the one
/// in a named home (`PATHOFDEV_HOME`, or `QUESTLINE_HOME` from before Path of Dev), else `~/.pathofdev` (`-dev` for the
/// dev sandbox), then `~/.questline`, where a server from before Path of Dev listens until it restarts.
pub fn socket_paths_of(named: Option<&Path>, home: Option<&Path>, dev: bool) -> Vec<PathBuf> {
    if let Some(named) = named {
        return vec![named.join("server.sock")];
    }
    let home = home.unwrap_or(Path::new(""));
    let folders = if dev {
        [".pathofdev-dev", ".questline-dev"]
    } else {
        [".pathofdev", ".questline"]
    };
    folders
        .iter()
        .map(|folder| home.join(folder).join("server.sock"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_sockets_where_the_mod_does() {
        let home = Path::new("/home/player");
        assert_eq!(
            socket_paths_of(None, Some(home), false),
            [
                PathBuf::from("/home/player/.pathofdev/server.sock"),
                PathBuf::from("/home/player/.questline/server.sock")
            ]
        );
        assert_eq!(
            socket_paths_of(None, Some(home), true),
            [
                PathBuf::from("/home/player/.pathofdev-dev/server.sock"),
                PathBuf::from("/home/player/.questline-dev/server.sock")
            ]
        );
        assert_eq!(
            socket_paths_of(Some(Path::new("/tmp/pod")), Some(home), true),
            [PathBuf::from("/tmp/pod/server.sock")]
        );
    }
}
