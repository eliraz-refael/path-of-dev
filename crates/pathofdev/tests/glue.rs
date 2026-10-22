//! The companion against a fake server, made with tiny_http on a Unix socket in a temp dir: the transport, the stream
//! thread from the snapshot to a live event, the server stopped and started again; and the home and socket checks.
//!
//! Every test here takes one lock: binding sets the process's umask for a moment, which would reach a file another
//! test made at the same time.

// An unwrap that fails here is the test failing, with the error it names.
#![allow(clippy::unwrap_used)]

use std::fs;
use std::io::{Read, Write};
use std::net::Shutdown;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use pathofdev::channel::{self, Bound, HomeError};
use pathofdev::client::Local;
use pathofdev::stream::{self, Link, Update};

static LOCK: Mutex<()> = Mutex::new(());

fn serial() -> MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A fresh, empty directory of the test's own, short enough for a socket path, removed when the test ends.
struct Scratch(PathBuf);

impl std::ops::Deref for Scratch {
    type Target = Path;

    fn deref(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o700));
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn scratch() -> Scratch {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "pod-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
    Scratch(dir)
}

fn fixture(file: &str) -> String {
    fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(file),
    )
    .unwrap()
}

/// What the fake server heard: each request's URL and its `PathOfDev-Client` header.
type Heard = Arc<Mutex<Vec<(String, Option<String>)>>>;

/// A server on `socket` that answers each request with what `answer` gives for its URL: a status, a body and a
/// `Retry-After`. It stops when dropped.
struct Fake {
    server: Arc<tiny_http::Server>,
    heard: Heard,
}

impl Fake {
    fn start(
        socket: &Path,
        answer: impl Fn(&str) -> (u16, String, Option<&'static str>) + Send + 'static,
    ) -> Fake {
        let server = Arc::new(tiny_http::Server::http_unix(socket).unwrap());
        let heard: Heard = Arc::default();
        let (inner, log) = (Arc::clone(&server), Arc::clone(&heard));
        thread::spawn(move || {
            for request in inner.incoming_requests() {
                let client = request
                    .headers()
                    .iter()
                    .find(|header| header.field.equiv("PathOfDev-Client"))
                    .map(|header| header.value.to_string());
                log.lock().unwrap().push((request.url().to_owned(), client));
                let (status, body, retry_after) = answer(request.url());
                let mut response = tiny_http::Response::from_string(body).with_status_code(status);
                if let Some(seconds) = retry_after {
                    response
                        .add_header(tiny_http::Header::from_bytes("Retry-After", seconds).unwrap());
                }
                let _ = request.respond(response);
            }
        });
        Fake { server, heard }
    }

    fn stop(self, socket: &Path) {
        self.server.unblock();
        drop(self);
        let _ = fs::remove_file(socket);
    }
}

/// The local server's answers: the fixtures' snapshot, then their stream from the start, then nothing new (after a
/// moment, as a held poll would).
fn game(url: &str) -> (u16, String, Option<&'static str>) {
    match url {
        "/v1/snapshot" => (200, fixture("contract/snapshot.json"), None),
        "/v1/stream?after=0" => (200, fixture("contract/stream.json"), None),
        _ => {
            thread::sleep(Duration::from_millis(50));
            (
                200,
                r#"{"events":[],"cursor":38,"rulesVersion":14,"minClientVersion":"0.0.0"}"#
                    .to_owned(),
                None,
            )
        }
    }
}

/// The updates heard within `within`, until `until` says enough.
fn hear_until(
    heard: &Receiver<Update>,
    within: Duration,
    until: impl Fn(&[Update]) -> bool,
) -> Vec<Update> {
    let deadline = Instant::now() + within;
    let mut updates = Vec::new();
    while !until(&updates) {
        let left = deadline.saturating_duration_since(Instant::now());
        match heard.recv_timeout(left) {
            Ok(update) => updates.push(update),
            Err(_) => panic!("heard only {updates:?}"),
        }
    }
    updates
}

#[test]
fn reads_each_answer_over_the_socket() {
    let _serial = serial();
    let dir = scratch();
    let socket = dir.join("server.sock");
    let fake = Fake::start(&socket, |url| match url {
        "/v1/snapshot" => (200, "{}".to_owned(), None),
        "/limited" => (429, r#"{"code":"limited"}"#.to_owned(), Some("7")),
        _ => (404, String::new(), None),
    });
    let mut local = Local::new(vec![socket.clone()]);
    let reply = local.get("/v1/snapshot").unwrap();
    assert_eq!((reply.status, reply.body.as_str()), (200, "{}"));
    let limited = local.get("/limited").unwrap();
    assert_eq!(
        (limited.status, limited.retry_after.as_deref()),
        (429, Some("7"))
    );
    assert_eq!(local.get("/nothing").unwrap().status, 404);
    let heard = fake.heard.lock().unwrap().clone();
    assert!(
        heard
            .iter()
            .all(|(_, client)| client.as_deref() == Some("watch/0.1.0")),
        "{heard:?}"
    );
    fake.stop(&socket);
}

#[test]
fn finds_the_server_on_its_second_socket_and_has_no_answer_without_one() {
    let _serial = serial();
    let dir = scratch();
    let (first, second) = (dir.join("a.sock"), dir.join("b.sock"));
    assert!(Local::new(vec![first.clone()]).get("/v1/snapshot").is_err());
    let fake = Fake::start(&second, |_| (200, "{}".to_owned(), None));
    let mut local = Local::new(vec![first, second.clone()]);
    assert_eq!(local.get("/v1/snapshot").unwrap().status, 200);
    fake.stop(&second);
}

/// A keep-alive HTTP server that, like a process that exits, closes every connection it has when it stops: tiny_http
/// keeps a connection's thread going after its server is dropped, which no restarted server does.
struct Exiting {
    connections: Arc<Mutex<Vec<UnixStream>>>,
    socket: PathBuf,
}

impl Exiting {
    fn start(socket: &Path, body: &'static str) -> Exiting {
        let listener = UnixListener::bind(socket).unwrap();
        let connections: Arc<Mutex<Vec<UnixStream>>> = Arc::default();
        let kept = Arc::clone(&connections);
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                kept.lock().unwrap().push(stream.try_clone().unwrap());
                thread::spawn(move || {
                    let mut buffer = [0; 4096];
                    // One request a read is enough for a GET with no body.
                    while matches!(stream.read(&mut buffer), Ok(read) if read > 0) {
                        let answer = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
                            body.len()
                        );
                        if stream.write_all(answer.as_bytes()).is_err() {
                            return;
                        }
                    }
                });
            }
        });
        Exiting {
            connections,
            socket: socket.to_owned(),
        }
    }

    fn exit(self) {
        // The socket goes first, so the accept loop's next connection is refused rather than taken.
        fs::remove_file(&self.socket).unwrap();
        for stream in self.connections.lock().unwrap().drain(..) {
            let _ = stream.shutdown(Shutdown::Both);
        }
    }
}

#[test]
fn hears_the_server_again_after_it_restarts() {
    let _serial = serial();
    let dir = scratch();
    let socket = dir.join("server.sock");
    let mut local = Local::new(vec![socket.clone()]);
    let first = Exiting::start(&socket, "first");
    assert_eq!(local.get("/").unwrap().body, "first");
    // The same connection again: it is kept alive between requests.
    assert_eq!(local.get("/").unwrap().body, "first");
    assert_eq!(first.connections.lock().unwrap().len(), 1);
    first.exit();
    let started = Instant::now();
    assert!(local.get("/").is_err());
    let second = Exiting::start(&socket, "second");
    assert_eq!(local.get("/").unwrap().body, "second");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "waited {:?} on a dead connection",
        started.elapsed()
    );
    second.exit();
}

#[test]
fn the_stream_thread_reads_the_snapshot_then_the_feed_and_never_names_a_session() {
    let _serial = serial();
    let dir = scratch();
    let socket = dir.join("server.sock");
    let fake = Fake::start(&socket, game);
    let (updates, heard) = mpsc::channel();
    let local = Local::new(vec![socket.clone()]);
    thread::spawn(move || stream::run(local, updates));
    let got = hear_until(&heard, Duration::from_secs(10), |updates| {
        updates
            .iter()
            .any(|update| matches!(update, Update::Events { backfill: true, .. }))
    });
    assert!(matches!(got[0], Update::Link(Link::Connecting)));
    assert!(got.iter().any(
        |update| matches!(update, Update::Snapshot(response) if response.snapshot.cursor == 38)
    ));
    // The live polls go on from the snapshot's cursor.
    let deadline = Instant::now() + Duration::from_secs(5);
    while !fake
        .heard
        .lock()
        .unwrap()
        .iter()
        .any(|(url, _)| url == "/v1/stream?after=38")
    {
        assert!(
            Instant::now() < deadline,
            "no poll after 38: {:?}",
            fake.heard.lock().unwrap()
        );
        thread::sleep(Duration::from_millis(20));
    }
    let urls: Vec<String> = fake
        .heard
        .lock()
        .unwrap()
        .iter()
        .map(|(url, _)| url.clone())
        .collect();
    assert_eq!(&urls[..2], ["/v1/snapshot", "/v1/stream?after=0"]);
    assert!(urls.iter().all(|url| !url.contains("session")), "{urls:?}");
    drop(heard);
    fake.stop(&socket);
}

#[test]
fn the_stream_thread_goes_offline_and_comes_back_when_the_server_starts() {
    let _serial = serial();
    let dir = scratch();
    let socket = dir.join("server.sock");
    let (updates, heard) = mpsc::channel();
    let local = Local::new(vec![socket.clone()]);
    thread::spawn(move || stream::run(local, updates));
    let got = hear_until(&heard, Duration::from_secs(5), |updates| {
        updates
            .iter()
            .any(|update| matches!(update, Update::Link(Link::Offline { .. })))
    });
    let Some(Update::Link(Link::Offline { retry_ms, .. })) = got.last() else {
        panic!("{got:?}")
    };
    assert!((5_000..=6_250).contains(retry_ms), "{retry_ms}");
    let fake = Fake::start(&socket, game);
    hear_until(&heard, Duration::from_secs(10), |updates| {
        updates
            .iter()
            .any(|update| matches!(update, Update::Snapshot(_)))
    });
    drop(heard);
    fake.stop(&socket);
}

#[test]
fn a_server_without_the_snapshot_route_is_told_to_update() {
    let _serial = serial();
    let dir = scratch();
    let socket = dir.join("server.sock");
    let fake = Fake::start(&socket, |_| {
        (404, r#"{"code":"not_found"}"#.to_owned(), None)
    });
    let (updates, heard) = mpsc::channel();
    let local = Local::new(vec![socket.clone()]);
    let thread = thread::spawn(move || stream::run(local, updates));
    hear_until(&heard, Duration::from_secs(5), |updates| {
        updates
            .iter()
            .any(|update| matches!(update, Update::Link(Link::ServerOlder)))
    });
    // The polling stops: the thread ends.
    thread.join().unwrap();
    assert_eq!(fake.heard.lock().unwrap().len(), 1);
    fake.stop(&socket);
}

// ── the home and watch.sock ──────────────────────────────────────────────────────────────────────────────────────────

fn mode(path: &Path) -> u32 {
    fs::symlink_metadata(path).unwrap().permissions().mode() & 0o777
}

#[test]
fn makes_the_home_0700_and_tightens_one_others_can_read() {
    let _serial = serial();
    let dir = scratch();
    let fresh = dir.join("home");
    channel::prepare_home(&fresh).unwrap();
    assert_eq!(mode(&fresh), 0o700);
    let open = dir.join("open");
    fs::create_dir(&open).unwrap();
    fs::set_permissions(&open, fs::Permissions::from_mode(0o755)).unwrap();
    channel::prepare_home(&open).unwrap();
    assert_eq!(mode(&open), 0o700);
}

#[test]
fn refuses_a_home_others_can_write_to_a_symlink_a_file_or_someone_elses() {
    let _serial = serial();
    let dir = scratch();
    let shared = dir.join("shared");
    fs::create_dir(&shared).unwrap();
    fs::set_permissions(&shared, fs::Permissions::from_mode(0o775)).unwrap();
    assert!(matches!(
        channel::prepare_home(&shared),
        Err(HomeError::OpenToOthers { .. })
    ));
    assert_eq!(mode(&shared), 0o775, "a refused home is left as it was");

    let real = dir.join("real");
    fs::create_dir(&real).unwrap();
    let link = dir.join("link");
    symlink(&real, &link).unwrap();
    assert!(matches!(
        channel::prepare_home(&link),
        Err(HomeError::Symlink(_))
    ));

    let file = dir.join("file");
    fs::write(&file, "").unwrap();
    assert!(channel::prepare_home(&file).is_err());

    // /usr is root's; a test run as root has no one else's directory to try.
    if rustix::process::getuid().as_raw() != 0 {
        assert!(matches!(
            channel::prepare_home(Path::new("/usr")),
            Err(HomeError::NotYours { .. })
        ));
    }
}

#[test]
fn binds_watch_sock_0600_once_and_answers_every_hello_400_for_now() {
    let _serial = serial();
    let home = scratch();
    let Bound::Listening(listener) = channel::bind(&home).unwrap() else {
        panic!("not bound")
    };
    let socket = home.join("watch.sock");
    assert_eq!(mode(&socket), 0o600);
    assert!(matches!(
        channel::bind(&home).unwrap(),
        Bound::AlreadyWatching
    ));

    let server = Arc::clone(&listener.server);
    thread::spawn(move || channel::serve(&server));
    let reply = Local::new(vec![socket.clone()]).get("/v1/watch").unwrap();
    assert_eq!((reply.status, reply.body.as_str()), (400, r#"{"v":1}"#));

    listener.server.unblock();
    drop(listener);
    assert!(!socket.exists(), "the socket outlived the companion");
}

#[test]
fn replaces_a_stale_socket_and_leaves_anything_else_alone() {
    let _serial = serial();
    let home = scratch();
    let socket = home.join("watch.sock");
    // A socket nobody listens on, as a crash leaves it.
    drop(UnixListener::bind(&socket).unwrap());
    assert!(socket.exists());
    let Bound::Listening(listener) = channel::bind(&home).unwrap() else {
        panic!("not bound")
    };
    listener.server.unblock();
    drop(listener);

    fs::write(&socket, "not a socket").unwrap();
    assert!(matches!(
        channel::bind(&home),
        Err(HomeError::NotASocket(_))
    ));
    assert_eq!(fs::read_to_string(&socket).unwrap(), "not a socket");
}

#[test]
fn refuses_a_socket_path_longer_than_unix_allows() {
    let _serial = serial();
    let dir = scratch();
    let deep = dir.join("d".repeat(channel::MAX_SOCKET_PATH));
    assert!(matches!(
        channel::bind(&deep),
        Err(HomeError::PathTooLong(_))
    ));
}

#[test]
fn makes_no_home_while_the_save_is_still_in_the_old_one() {
    let _serial = serial();
    let user = scratch();
    fs::create_dir(user.join(".questline")).unwrap();
    // The local server moves ~/.questline only while ~/.pathofdev is missing: one made now would strand the save.
    let Err(HomeError::LegacySave { legacy, home }) = channel::home_of(None, Some(&user), false)
    else {
        panic!("a home was picked beside the old save")
    };
    assert_eq!(
        (legacy, home),
        (user.join(".questline"), user.join(".pathofdev"))
    );
    assert!(!user.join(".pathofdev").exists());
    // The dev sandbox is a save of its own: the old one is no reason to refuse it.
    assert_eq!(
        channel::home_of(None, Some(&user), true).unwrap(),
        user.join(".pathofdev-dev")
    );

    fs::create_dir(user.join(".pathofdev")).unwrap();
    assert_eq!(
        channel::home_of(None, Some(&user), false).unwrap(),
        user.join(".pathofdev")
    );
    let named = user.join("named");
    assert_eq!(
        channel::home_of(Some(&named), Some(&user), false).unwrap(),
        named
    );
    assert!(matches!(
        channel::home_of(None, None, false),
        Err(HomeError::NoHome)
    ));
}

#[test]
fn the_binary_says_it_needs_a_terminal_rather_than_panicking() {
    let _serial = serial();
    let user = scratch();
    let home = user.join("home");
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_pathofdev"))
        .arg("watch")
        .env_remove("QUESTLINE_HOME")
        .env("PATHOFDEV_HOME", &home)
        .env("HOME", &*user)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .unwrap();
    let said = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(1), "{said}");
    assert!(said.contains("draws in a terminal"), "{said}");
    assert!(!said.contains("panicked"), "{said}");
    assert!(out.stdout.is_empty(), "escapes went down the pipe");
    assert!(!home.exists(), "a home was made for a screen nobody sees");
}
