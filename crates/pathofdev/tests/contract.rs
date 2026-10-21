//! The companion against the TypeScript's own answers: every fixture decodes, and every field the decoders skip is one
//! `contract/unread.txt` lists, so the two sides can't drift apart unseen.
//!
//!   a field renamed in TypeScript ─▶ a field the companion reads goes missing (the decode fails), or the new name
//!                                    shows up unread
//!   a field added                 ─▶ it shows up unread, until the companion reads it or unread.txt lists it
//!   a field removed               ─▶ the decode fails if the companion read it, else unread.txt has a stale line
//!
//! The fixtures are written by the TypeScript (`pnpm contract`). `PATHOFDEV_WRITE_UNREAD=1 cargo test --test contract`
//! writes unread.txt from what the decoders skip now, for a change that means to leave a new field alone.

// An unwrap that fails here is the test failing, with the error it names.
#![allow(clippy::unwrap_used)]

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use pathofdev::wire::{SnapshotResponse, StreamResponse};
use serde::de::DeserializeOwned;
use serde_json::Value;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Each route and the fixtures of its answer.
const FIXTURES: [(&str, &str); 4] = [
    // The plain player's answer, pinned with its JSON Schema by the snapshot route's own test.
    (
        "GET /v1/snapshot",
        "packages/server/test/contract/snapshot-response.json",
    ),
    ("GET /v1/snapshot", "contract/snapshot.json"),
    ("GET /v1/stream", "contract/stream.json"),
    ("GET /v1/stream", "contract/stream-resync.json"),
];

enum Segment {
    Key(String),
    Index(usize),
}

/// The path serde_ignored reports, from the root down, without the steps that name no field.
fn segments(path: &serde_ignored::Path) -> Vec<Segment> {
    let mut out = Vec::new();
    let mut at = path;
    loop {
        at = match at {
            serde_ignored::Path::Root => break,
            serde_ignored::Path::Seq { parent, index } => {
                out.push(Segment::Index(*index));
                parent
            }
            serde_ignored::Path::Map { parent, key } => {
                out.push(Segment::Key(key.clone()));
                parent
            }
            serde_ignored::Path::Some { parent }
            | serde_ignored::Path::NewtypeStruct { parent }
            | serde_ignored::Path::NewtypeVariant { parent } => parent,
        };
    }
    out.reverse();
    out
}

/// A path as unread.txt writes it: keys joined by dots, an array's items as `[]`, or `[<type>]` for an item that names
/// its type, as an event does, so each event type's unread fields read apart.
fn label(segments: &[Segment], json: &Value) -> String {
    let mut out = String::new();
    let mut at = Some(json);
    for segment in segments {
        match segment {
            Segment::Key(key) => {
                if !out.is_empty() {
                    out.push('.');
                }
                out.push_str(key);
                at = at.and_then(|value| value.get(key));
            }
            Segment::Index(index) => {
                let item = at.and_then(|value| value.get(index));
                match item
                    .and_then(|item| item.get("type"))
                    .and_then(Value::as_str)
                {
                    Some(kind) => out.push_str(&format!("[{kind}]")),
                    None => out.push_str("[]"),
                }
                at = item;
            }
        }
    }
    out
}

/// The fields `T` skips in `file`, labelled.
fn unread<T: DeserializeOwned>(file: &str) -> BTreeSet<String> {
    let text =
        fs::read_to_string(repo().join(file)).unwrap_or_else(|error| panic!("{file}: {error}"));
    let json: Value = serde_json::from_str(&text).unwrap();
    let mut skipped = Vec::new();
    let mut deserializer = serde_json::Deserializer::from_str(&text);
    serde_ignored::deserialize::<_, _, T>(&mut deserializer, |path| skipped.push(segments(&path)))
        .unwrap_or_else(|error| panic!("{file} doesn't decode: {error}"));
    skipped.iter().map(|path| label(path, &json)).collect()
}

fn ledger() -> BTreeSet<String> {
    let mut lines = BTreeSet::new();
    for (route, file) in FIXTURES {
        let fields = match route {
            "GET /v1/snapshot" => unread::<SnapshotResponse>(file),
            _ => unread::<StreamResponse>(file),
        };
        lines.extend(fields.into_iter().map(|field| format!("{route} {field}")));
    }
    lines
}

const HEADER: &str = "\
# The fields of the server's answers that the companion leaves alone, by route: every field its decoders skip in the
# fixtures (contract/, and the snapshot route's pinned answer) is here, and nothing else is. An array's items are [],
# or [<type>] for an event. See crates/pathofdev/tests/contract.rs.
";

#[test]
fn every_fixture_decodes_and_skips_only_what_unread_txt_lists() {
    let found = ledger();
    let file = repo().join("contract/unread.txt");
    if std::env::var("PATHOFDEV_WRITE_UNREAD").as_deref() == Ok("1") {
        let lines: Vec<&str> = found.iter().map(String::as_str).collect();
        fs::write(&file, format!("{HEADER}{}\n", lines.join("\n"))).unwrap();
    }
    let listed: BTreeSet<String> = fs::read_to_string(&file)
        .unwrap()
        .lines()
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_owned)
        .collect();
    let new: Vec<&String> = found.difference(&listed).collect();
    let stale: Vec<&String> = listed.difference(&found).collect();
    assert!(
        new.is_empty() && stale.is_empty(),
        "contract/unread.txt is out of step with the decoders.\n\
         Skipped but not listed (read them, or list them):\n  {}\n\
         Listed but not skipped (the field went away, or is read now):\n  {}",
        new.iter()
            .map(|line| line.as_str())
            .collect::<Vec<_>>()
            .join("\n  "),
        stale
            .iter()
            .map(|line| line.as_str())
            .collect::<Vec<_>>()
            .join("\n  "),
    );
}

#[test]
fn the_stream_fixture_carries_every_event_the_companion_draws() {
    use pathofdev::wire::EventBody;
    let text = fs::read_to_string(repo().join("contract/stream.json")).unwrap();
    let stream: StreamResponse = serde_json::from_str(&text).unwrap();
    let mut drawn = BTreeSet::new();
    for event in &stream.events {
        drawn.insert(match event.body {
            EventBody::XpGranted(_) => "xp.granted",
            EventBody::LevelUp(_) => "level.up",
            EventBody::LootDropped(_) => "loot.dropped",
            EventBody::QuestProgress(_) => "quest.progress",
            EventBody::QuestCompleted(_) => "quest.completed",
            EventBody::AchievementUnlocked(_) => "achievement.unlocked",
            EventBody::PetHatched(_) => "pet.hatched",
            EventBody::Other => continue,
        });
    }
    assert_eq!(drawn.len(), 7, "the stream fixture draws only {drawn:?}");
    let graded = stream.events.iter().any(|event| {
        matches!(&event.body, EventBody::XpGranted(xp) if xp.grade.is_some() && xp.sigil.is_some())
    });
    assert!(
        graded,
        "no graded prompt with a sigil in the stream fixture"
    );
}
