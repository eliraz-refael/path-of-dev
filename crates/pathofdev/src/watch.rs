//! `pathofdev watch`: the home and its socket, then the stream and channel threads, then the screen until `q`.

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
    let home = channel::home_of(named.as_deref(), user_home.as_deref(), dev)
        .ok_or("Neither PATHOFDEV_HOME nor HOME is set: there is no home to watch from")?;
    channel::prepare_home(&home)?;
    // The bind sets the umask, which is the process's: it runs before any thread starts.
    let listener = match channel::bind(&home)? {
        Bound::AlreadyWatching => return Ok(Ended::AlreadyWatching),
        Bound::Listening(listener) => listener,
    };
    let sprite = Sprite::embedded()?;
    let sockets = client::socket_paths_of(named.as_deref(), user_home.as_deref(), dev);

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
    // ratatui::init also installs a panic hook that gives the terminal back before the panic prints.
    let mut terminal = ratatui::init();
    let result = ui::run(&mut terminal, &mut app, &heard);
    ratatui::restore();
    drop(listener);
    result?;
    Ok(Ended::Quit)
}
