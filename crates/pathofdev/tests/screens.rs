//! The screens, drawn from the contract's fixtures at a fixed time in UTC, against the text in `tests/screens/`. The
//! fixtures are a real server's answers, so the words are the game's own. `PATHOFDEV_WRITE_SCREENS=1 cargo test --test
//! screens` writes the files again, for a change meant to change a screen: read the diff.

// An unwrap that fails here is the test failing, with the error it names.
#![allow(clippy::unwrap_used)]

use std::fs;
use std::path::{Path, PathBuf};

use jiff::Timestamp;
use jiff::tz::TimeZone;
use pathofdev::stream::{Link, Update};
use pathofdev::ui::app::{App, Tab, Target};
use pathofdev::ui::sprite::Sprite;
use pathofdev::ui::theme::Theme;
use pathofdev::ui::{render, text_of};
use pathofdev::wire::{SnapshotResponse, StreamResponse};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn fixture<T: serde::de::DeserializeOwned>(file: &str) -> T {
    serde_json::from_str(&fs::read_to_string(repo().join(file)).unwrap()).unwrap()
}

/// Five minutes after the fixtures' play, which the test server ran at 08:00 UTC.
fn now() -> Timestamp {
    "2026-10-09T08:05:00Z".parse().unwrap()
}

fn app() -> App {
    App::new(
        Target::Local,
        Sprite::embedded().unwrap(),
        Theme { truecolor: true },
        now(),
        TimeZone::UTC,
    )
}

/// The app after the fixtures' snapshot and stream, as a fresh companion hears them.
fn played() -> App {
    let mut app = app();
    let snapshot: SnapshotResponse = fixture("contract/snapshot.json");
    let stream: StreamResponse = fixture("contract/stream.json");
    app.apply(Update::Link(Link::Live));
    app.apply(Update::Snapshot(Box::new(snapshot)));
    app.apply(Update::Events {
        events: stream.events,
        backfill: true,
    });
    app
}

fn screen(app: &App, width: u16, height: u16) -> String {
    let area = Rect::new(0, 0, width, height);
    let mut buf = Buffer::empty(area);
    render(app, area, &mut buf);
    text_of(&buf)
}

/// The screen held to `tests/screens/<name>.txt`.
fn pin(name: &str, text: &str) {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/screens/{name}.txt"));
    if std::env::var("PATHOFDEV_WRITE_SCREENS").as_deref() == Ok("1") {
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, text).unwrap();
    }
    let pinned = fs::read_to_string(&file).unwrap_or_default();
    assert_eq!(
        text, pinned,
        "tests/screens/{name}.txt differs: PATHOFDEV_WRITE_SCREENS=1 writes it again"
    );
}

#[test]
fn home_at_three_sizes() {
    let app = played();
    for (width, height) in [(40, 16), (80, 24), (120, 40)] {
        pin(
            &format!("home-{width}x{height}"),
            &screen(&app, width, height),
        );
    }
}

#[test]
fn home_while_the_server_is_down() {
    let mut app = played();
    app.apply(Update::Link(Link::Offline { retry_ms: 12_000 }));
    pin("home-offline-80x24", &screen(&app, 80, 24));

    let mut fresh = self::app();
    fresh.apply(Update::Link(Link::Offline { retry_ms: 5_000 }));
    pin("offline-80x24", &screen(&fresh, 80, 24));
}

#[test]
fn home_before_the_first_answer() {
    pin("connecting-80x24", &screen(&app(), 80, 24));
}

#[test]
fn a_server_without_the_snapshot_route() {
    let mut app = app();
    app.apply(Update::Link(Link::ServerOlder));
    pin("server-older-80x24", &screen(&app, 80, 24));
}

#[test]
fn the_other_tabs_and_the_keys() {
    let mut app = played();
    app.tab = Tab::Missions;
    pin("missions-80x24", &screen(&app, 80, 24));
    app.tab = Tab::Home;
    app.help = true;
    pin("keys-80x24", &screen(&app, 80, 24));
}

#[test]
fn a_pane_too_small() {
    pin("small-39x16", &screen(&played(), 39, 16));
    pin("small-60x15", &screen(&played(), 60, 15));
}
