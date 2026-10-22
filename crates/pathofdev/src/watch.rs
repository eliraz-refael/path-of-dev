//! `pathofdev watch`: the home and its socket, then the stream and channel threads, then the screen until `q`.

use std::io::IsTerminal;
use std::path::PathBuf;
use std::sync::{Arc, mpsc};
use std::thread;

use jiff::Timestamp;
use jiff::tz::TimeZone;

use crate::channel::{self, Bound};
use crate::client::{self, Local};
use crate::stream;
use crate::ui::{self, app::App, app::Target, sprite::Sprite, theme::Theme};

/// How a watch ended.
pub enum Ended {
    /// The player quit.
    Quit,
    /// Another companion already watches this home.
    AlreadyWatching,
}

/// An environment variable, unless it is unset or empty.
fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

pub fn watch(dev: bool) -> Result<Ended, Box<dyn std::error::Error>> {
    // As the mod and the local server read them: a home named under its old name still counts.
    let named = env_path("PATHOFDEV_HOME").or_else(|| env_path("QUESTLINE_HOME"));
    let user_home = env_path("HOME");
    // A screen drawn into a pipe or a file is escapes nobody reads: say so and make nothing.
    if !std::io::stdout().is_terminal() {
        return Err(
            "pathofdev watch draws in a terminal: run it in a pane, not with its output piped"
                .into(),
        );
    }
    let home = channel::home_of(named.as_deref(), user_home.as_deref(), dev)?;
    channel::prepare_home(&home)?;
    // The bind sets the umask, which is the process's: it runs before any thread starts.
    let listener = match channel::bind(&home)? {
        Bound::AlreadyWatching => return Ok(Ended::AlreadyWatching),
        Bound::Listening(listener) => listener,
    };
    let sprite = Sprite::embedded()?;
    let sockets = client::socket_paths_of(named.as_deref(), user_home.as_deref(), dev);

    // Before any thread starts, so a terminal that can't go raw (no controlling terminal to read keys from) ends here,
    // with the reason, and not in a panic.
    let mut terminal = ratatui::try_init()
        .map_err(|error| format!("pathofdev watch needs a terminal to draw in: {error}"))?;
    exit_on_panic();
    let result = run(&mut terminal, sprite, sockets, &listener, dev);
    ratatui::restore();
    drop(listener);
    result?;
    Ok(Ended::Quit)
}

/// The threads and the screen, in a terminal ready to draw in.
fn run(
    terminal: &mut ratatui::DefaultTerminal,
    sprite: Sprite,
    sockets: Vec<PathBuf>,
    listener: &channel::Listener,
    dev: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let (updates, heard) = mpsc::channel();
    thread::Builder::new()
        .name("stream".into())
        .spawn(move || stream::run(Local::new(sockets), updates))?;
    let server = Arc::clone(&listener.server);
    thread::Builder::new()
        .name("channel".into())
        .spawn(move || channel::serve(&server))?;

    let target = if dev { Target::Dev } else { Target::Local };
    let theme = Theme::for_colorterm(std::env::var("COLORTERM").ok().as_deref());
    let mut app = App::new(target, sprite, theme, Timestamp::now(), TimeZone::system());
    Ok(ui::run(terminal, &mut app, &heard)?)
}

/// ratatui's hook gives the terminal back and prints the panic, but a panic kills only its own thread: one in the
/// stream thread would leave the screen drawing a feed that never moves. So after the hook, the process ends. The
/// socket it leaves behind is a stale one, which the next start replaces.
fn exit_on_panic() {
    let restore_and_print = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore_and_print(info);
        std::process::exit(101);
    }));
}
