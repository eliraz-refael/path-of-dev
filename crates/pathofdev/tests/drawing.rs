//! Drawing, as properties: at any size the screen draws without a panic and no line is wider than the pane, below
//! 40×16 it asks for more room, and no string from the server reaches the screen with a control character in it.

// An unwrap that fails here is the test failing, with the error it names.
#![allow(clippy::unwrap_used)]

use std::fs;
use std::path::Path;

use jiff::Timestamp;
use jiff::tz::TimeZone;
use pathofdev::stream::{Link, Update};
use pathofdev::ui::app::{App, Tab, Target};
use pathofdev::ui::sprite::Sprite;
use pathofdev::ui::theme::Theme;
use pathofdev::ui::{MIN_HEIGHT, MIN_WIDTH, render, text_of};
use pathofdev::wire::{SnapshotResponse, StreamResponse, Text, is_control};
use proptest::prelude::*;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::text::Span;

fn fixture<T: serde::de::DeserializeOwned>(file: &str) -> T {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(file);
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn link() -> impl Strategy<Value = Link> {
    prop_oneof![
        Just(Link::Connecting),
        Just(Link::Live),
        (0..30_000u64).prop_map(|retry_ms| Link::Offline { retry_ms }),
        (0..600_000u64).prop_map(|wait_ms| Link::Limited { wait_ms }),
        Just(Link::SignedOut),
        Just(Link::ServerOlder),
        Just(Link::ServerNewer),
    ]
}

fn app(played: bool, link: Link, tab: usize, help: bool, truecolor: bool) -> App {
    let now: Timestamp = "2026-10-09T08:05:00Z".parse().unwrap();
    let mut app = App::new(
        Target::Dev,
        Sprite::embedded().unwrap(),
        Theme { truecolor },
        now,
        TimeZone::UTC,
    );
    if played {
        let snapshot: SnapshotResponse = fixture("contract/snapshot.json");
        let stream: StreamResponse = fixture("contract/stream.json");
        app.apply(Update::Snapshot(Box::new(snapshot)));
        app.apply(Update::Events {
            events: stream.events,
            backfill: true,
        });
    }
    app.apply(Update::Link(link));
    app.tab = Tab::ALL[tab];
    app.help = help;
    app
}

fn screen(app: &App, width: u16, height: u16) -> String {
    let area = Rect::new(0, 0, width, height);
    let mut buf = Buffer::empty(area);
    render(app, area, &mut buf);
    text_of(&buf)
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 256, ..ProptestConfig::default() })]

    #[test]
    fn every_size_draws_within_the_pane(
        width in 0..220u16,
        height in 0..70u16,
        played in any::<bool>(),
        link in link(),
        tab in 0..4usize,
        help in any::<bool>(),
        truecolor in any::<bool>(),
    ) {
        let app = app(played, link, tab, help, truecolor);
        let text = screen(&app, width, height);
        for line in text.lines() {
            prop_assert!(Span::raw(line).width() <= usize::from(width), "{width}×{height}: {line:?}");
        }
        let small = width < MIN_WIDTH || height < MIN_HEIGHT;
        if width >= 22 && height >= 2 {
            prop_assert_eq!(small, text.contains("Make this pane bigger"));
        }
    }

    #[test]
    fn no_decoded_string_holds_a_control_character(raw in any::<String>()) {
        let json = serde_json::to_string(&raw).unwrap();
        let text: Text = serde_json::from_str(&json).unwrap();
        prop_assert!(!text.as_str().chars().any(is_control));
        let kept: String = raw.chars().filter(|c| !is_control(*c)).collect();
        prop_assert_eq!(text.as_str(), kept.as_str());
    }
}

#[test]
fn a_name_with_escapes_in_it_draws_without_them() {
    let mut snapshot: SnapshotResponse = fixture("contract/snapshot.json");
    let raw = serde_json::to_string("Mira\u{1b}]0;owned\u{7}").unwrap();
    snapshot.snapshot.character.name = serde_json::from_str(&raw).unwrap();
    let mut app = app(false, Link::Live, 0, false, true);
    app.apply(Update::Snapshot(Box::new(snapshot)));
    let text = screen(&app, 80, 24);
    assert!(text.contains("Mira]0;owned ·"), "{text}");
    assert!(text.lines().all(|line| !line.chars().any(is_control)));
}
