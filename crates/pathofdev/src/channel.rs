//! The companion's home and its socket, `watch.sock`, where the mod will push what only the player's machine may see
//! (the Last prompt card, Haiku's note, the misspelled words, the online token). The push lands in a later version:
//! for now every request is answered 400 with `{ "v": 1 }`, which tells a mod that this companion takes no hello yet.
//!
//! Only the player's own user may reach the socket, as with the local server's `server.sock`:
//!
//! ```text
//! home: made 0700 ─▶ refused if a symlink, not a directory, someone else's, or writable by others ─▶ chmod 0700
//! watch.sock: path short enough ─▶ another companion answering? "already watching", exit 0
//!             ─▶ a stale one (nobody answers) removed ─▶ bound under umask 0177, so 0600 ─▶ its mode checked
//! ```
//!
//! A home others can write to is refused, not fixed: anyone who could write there could have put something in it.

use std::fmt;
use std::fs::{self, DirBuilder, Permissions};
use std::io;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};

use rustix::fs::Mode;

/// sun_path holds 104 bytes on macOS and 108 on Linux, with the terminating zero.
#[cfg(target_os = "macos")]
pub const MAX_SOCKET_PATH: usize = 103;
#[cfg(not(target_os = "macos"))]
pub const MAX_SOCKET_PATH: usize = 107;

/// Why the companion can't use its home.
#[derive(Debug)]
pub enum HomeError {
    Io { path: PathBuf, error: io::Error },
    Symlink(PathBuf),
    NotADirectory(PathBuf),
    NotYours { path: PathBuf, owner: u32 },
    OpenToOthers { path: PathBuf, mode: u32 },
    PathTooLong(PathBuf),
    NotASocket(PathBuf),
    SocketMode { path: PathBuf, mode: u32 },
    Bind { path: PathBuf, error: String },
    NoHome,
    LegacySave { legacy: PathBuf, home: PathBuf },
}

impl fmt::Display for HomeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HomeError::Io { path, error } => write!(f, "{}: {error}", path.display()),
            HomeError::Symlink(path) => write!(
                f,
                "{} is a symlink: the home must be a directory of its own",
                path.display()
            ),
            HomeError::NotADirectory(path) => write!(f, "{} is not a directory", path.display()),
            HomeError::NotYours { path, owner } => {
                write!(
                    f,
                    "{} belongs to user {owner}, not to you: the home must be your own",
                    path.display()
                )
            }
            HomeError::OpenToOthers { path, mode } => write!(
                f,
                "{} is writable by others (mode {mode:o}): run chmod 700 on it, or name another home with PATHOFDEV_HOME",
                path.display()
            ),
            HomeError::PathTooLong(path) => write!(
                f,
                "The socket path is longer than Unix sockets allow ({MAX_SOCKET_PATH} bytes): {}. Name a shorter home \
                 with PATHOFDEV_HOME",
                path.display()
            ),
            HomeError::NotASocket(path) => {
                write!(
                    f,
                    "{} is there and is not a socket: move it away, then start pathofdev again",
                    path.display()
                )
            }
            HomeError::SocketMode { path, mode } => {
                write!(
                    f,
                    "{} was made with mode {mode:o}, not 600: nothing is listening on it",
                    path.display()
                )
            }
            HomeError::Bind { path, error } => {
                write!(f, "Could not listen on {}: {error}", path.display())
            }
            HomeError::NoHome => write!(
                f,
                "Neither PATHOFDEV_HOME nor HOME is set: there is no home to watch from"
            ),
            HomeError::LegacySave { legacy, home } => write!(
                f,
                "Your save is still in {}, from before Path of Dev. Start the local server once (pnpm --filter \
                 @pathofdev/server start), which moves it to {}, then run pathofdev watch again",
                legacy.display(),
                home.display()
            ),
        }
    }
}

impl std::error::Error for HomeError {}

fn io_at(path: &Path) -> impl FnOnce(io::Error) -> HomeError + '_ {
    move |error| HomeError::Io {
        path: path.to_owned(),
        error,
    }
}

/// Makes `home` 0700 if it is missing, and checks it is a directory of the player's own that nobody else can write to.
pub fn prepare_home(home: &Path) -> Result<(), HomeError> {
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(home)
        .map_err(io_at(home))?;
    let meta = fs::symlink_metadata(home).map_err(io_at(home))?;
    if meta.file_type().is_symlink() {
        return Err(HomeError::Symlink(home.to_owned()));
    }
    if !meta.is_dir() {
        return Err(HomeError::NotADirectory(home.to_owned()));
    }
    let uid = rustix::process::getuid().as_raw();
    if meta.uid() != uid {
        return Err(HomeError::NotYours {
            path: home.to_owned(),
            owner: meta.uid(),
        });
    }
    if meta.mode() & 0o022 != 0 {
        return Err(HomeError::OpenToOthers {
            path: home.to_owned(),
            mode: meta.mode() & 0o777,
        });
    }
    // mkdir leaves an existing directory's mode alone.
    fs::set_permissions(home, Permissions::from_mode(0o700)).map_err(io_at(home))
}

/// What binding the socket came to.
pub enum Bound {
    /// The socket is this companion's until it is dropped, which removes it.
    Listening(Listener),
    /// Another companion answers on the socket.
    AlreadyWatching,
}

/// The bound `watch.sock`, removed when dropped.
pub struct Listener {
    pub path: PathBuf,
    pub server: std::sync::Arc<tiny_http::Server>,
}

impl Drop for Listener {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

/// Binds `home/watch.sock`, 0600, unless another companion already answers there. Call it before starting any thread:
/// the umask it sets for the bind is the process's.
pub fn bind(home: &Path) -> Result<Bound, HomeError> {
    let path = home.join("watch.sock");
    if path.as_os_str().len() > MAX_SOCKET_PATH {
        return Err(HomeError::PathTooLong(path));
    }
    match fs::symlink_metadata(&path) {
        Ok(meta) if !meta.file_type().is_socket() => return Err(HomeError::NotASocket(path)),
        Ok(_) => {
            if UnixStream::connect(&path).is_ok() {
                return Ok(Bound::AlreadyWatching);
            }
            // Nobody answers: a companion that crashed left it.
            fs::remove_file(&path).map_err(io_at(&path))?;
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(HomeError::Io { path, error }),
    }
    let before = rustix::process::umask(Mode::from_raw_mode(0o177));
    let server = tiny_http::Server::http_unix(&path);
    rustix::process::umask(before);
    let server = server.map_err(|error| HomeError::Bind {
        path: path.clone(),
        error: error.to_string(),
    })?;
    let listener = Listener {
        path,
        server: std::sync::Arc::new(server),
    };
    let mode = fs::symlink_metadata(&listener.path)
        .map_err(io_at(&listener.path))?
        .mode()
        & 0o777;
    if mode != 0o600 {
        return Err(HomeError::SocketMode {
            path: listener.path.clone(),
            mode,
        });
    }
    Ok(Bound::Listening(listener))
}

/// The socket's thread: every hello is answered 400 for now, with the protocol version this side will speak.
pub fn serve(server: &tiny_http::Server) {
    for request in server.incoming_requests() {
        let mut response = tiny_http::Response::from_string(r#"{"v":1}"#).with_status_code(400);
        if let Ok(header) = tiny_http::Header::from_bytes("Content-Type", "application/json") {
            response.add_header(header);
        }
        let _ = request.respond(response);
    }
}

/// The home: `PATHOFDEV_HOME` (or `QUESTLINE_HOME`, its name from before Path of Dev) when set, else `~/.pathofdev`, or
/// `~/.pathofdev-dev` for the dev sandbox, as the local server picks its own.
///
/// While only `~/.questline` (`-dev`) holds a save, the companion makes no home: the local server moves the old one
/// on its next start only when the new one is missing, and once both exist it plays a fresh save in the new one.
pub fn home_of(named: Option<&Path>, home: Option<&Path>, dev: bool) -> Result<PathBuf, HomeError> {
    if let Some(named) = named {
        return Ok(named.to_owned());
    }
    let home = home.ok_or(HomeError::NoHome)?;
    let (folder, legacy) = if dev {
        (".pathofdev-dev", ".questline-dev")
    } else {
        (".pathofdev", ".questline")
    };
    let (folder, legacy) = (home.join(folder), home.join(legacy));
    // symlink_metadata, so a dangling symlink counts as there: prepare_home refuses it, as it should.
    if fs::symlink_metadata(&folder).is_err() && fs::symlink_metadata(&legacy).is_ok() {
        return Err(HomeError::LegacySave {
            legacy,
            home: folder,
        });
    }
    Ok(folder)
}
