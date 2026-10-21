//! The stream machine's rules, as properties over any run of answers: the cursor never goes back but on a resync, a
//! resync or newer rules always read the snapshot again, a sign-out asks nothing more, the backoff stays in 5–30 s and
//! grows until an answer, and no poll names a session.

// An unwrap that fails here is the test failing, with the error it names.
#![allow(clippy::unwrap_used)]

use std::fs;
use std::path::Path;

use pathofdev::stream::{self, Answer, Ask, BACKOFF_MAX_MS, BACKOFF_MIN_MS, Machine, Step};
use pathofdev::wire::{SnapshotResponse, StreamResponse};
use proptest::prelude::*;

fn fixture<T: serde::de::DeserializeOwned>(file: &str) -> T {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(file);
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

/// An answer, as data proptest can make and shrink.
#[derive(Debug, Clone)]
enum Said {
    Snapshot {
        cursor: u64,
        rules: u64,
    },
    Stream {
        cursor: u64,
        events: bool,
        resync: bool,
        rules: u64,
    },
    Limited {
        wait_ms: u64,
    },
    Down,
    SignedOut,
}

fn said() -> impl Strategy<Value = Said> {
    prop_oneof![
        (0..500u64, 10..20u64).prop_map(|(cursor, rules)| Said::Snapshot { cursor, rules }),
        (
            0..500u64,
            any::<bool>(),
            prop::bool::weighted(0.15),
            10..20u64
        )
            .prop_map(|(cursor, events, resync, rules)| Said::Stream {
                cursor,
                events,
                resync,
                rules
            }),
        (0..2_000_000u64).prop_map(|wait_ms| Said::Limited { wait_ms }),
        Just(Said::Down),
        Just(Said::Down),
        Just(Said::SignedOut),
    ]
}

fn answer(said: &Said) -> Answer {
    match said {
        Said::Snapshot { cursor, rules } => {
            let mut response: SnapshotResponse = fixture("contract/snapshot.json");
            response.snapshot.cursor = *cursor;
            response.rules.version = *rules;
            Answer::Snapshot(Box::new(response))
        }
        Said::Stream {
            cursor,
            events,
            resync,
            rules,
        } => {
            let mut response: StreamResponse = fixture("contract/stream.json");
            if !events {
                response.events.clear();
            }
            response.cursor = *cursor;
            response.resync = resync.then_some(true);
            response.rules_version = *rules;
            Answer::Stream(response)
        }
        Said::Limited { wait_ms } => Answer::Limited { wait_ms: *wait_ms },
        Said::Down => Answer::Down { status: None },
        Said::SignedOut => Answer::SignedOut,
    }
}

/// Every step of a run of `answers`, with the machine before it.
fn run(answers: &[Said], jitter: f64) -> Vec<(Machine, Said, Machine, Step)> {
    let (mut machine, _) = stream::start();
    let mut steps = Vec::new();
    for said in answers {
        let before = machine.clone();
        let (after, step) = stream::next(machine, answer(said), jitter);
        steps.push((before, said.clone(), after.clone(), step));
        machine = after;
    }
    steps
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 128, ..ProptestConfig::default() })]

    #[test]
    fn the_cursor_goes_back_only_on_a_resync(answers in prop::collection::vec(said(), 1..40), jitter in 0.0..1.0f64) {
        for (before, said, after, _) in run(&answers, jitter) {
            let resynced = before.resyncing && matches!(said, Said::Snapshot { .. });
            prop_assert!(resynced || after.cursor >= before.cursor, "{said:?}: {} to {}", before.cursor, after.cursor);
        }
    }

    #[test]
    fn a_resync_or_newer_rules_read_the_snapshot_again(answers in prop::collection::vec(said(), 1..40)) {
        for (before, said, _, step) in run(&answers, 0.5) {
            if let Said::Stream { resync, rules, .. } = said {
                let newer = before.rules_version.is_some_and(|known| rules > known);
                if resync || newer {
                    prop_assert_eq!(step.ask, Some(Ask::Snapshot));
                }
            }
        }
    }

    #[test]
    fn after_a_sign_out_nothing_more_is_asked(answers in prop::collection::vec(said(), 1..40)) {
        for (_, said, _, step) in run(&answers, 0.5) {
            if matches!(said, Said::SignedOut) {
                prop_assert_eq!(step.ask, None);
            }
        }
    }

    #[test]
    fn the_backoff_stays_in_5_to_30_s_grows_and_resets(answers in prop::collection::vec(said(), 1..60), jitter in 0.0..1.0f64) {
        let mut last_wait: Option<u64> = None;
        for (_, said, _, step) in run(&answers, jitter) {
            match said {
                Said::Down => {
                    prop_assert!((BACKOFF_MIN_MS..=BACKOFF_MAX_MS).contains(&step.wait_ms));
                    if let Some(last) = last_wait {
                        prop_assert!(step.wait_ms >= last, "{} after {last}", step.wait_ms);
                    } else {
                        // The first failure after an answer waits the least again.
                        prop_assert!(step.wait_ms <= BACKOFF_MIN_MS + BACKOFF_MIN_MS / 4);
                    }
                    last_wait = Some(step.wait_ms);
                }
                Said::Snapshot { .. } | Said::Stream { .. } => last_wait = None,
                Said::Limited { .. } | Said::SignedOut => {}
            }
        }
    }

    #[test]
    fn no_poll_names_a_session(answers in prop::collection::vec(said(), 1..40)) {
        for (_, _, _, step) in run(&answers, 0.5) {
            if let Some(ask) = step.ask {
                prop_assert!(!ask.path().contains("session"), "{}", ask.path());
            }
        }
    }

    #[test]
    fn a_429_waits_between_a_second_and_ten_minutes(wait_ms in any::<u64>()) {
        let (machine, _) = stream::start();
        let (_, step) = stream::next(machine, Answer::Limited { wait_ms }, 0.5);
        prop_assert!((1_000..=600_000).contains(&step.wait_ms));
        prop_assert_eq!(step.ask, Some(Ask::Snapshot));
    }
}

#[test]
fn a_fresh_companion_reads_the_snapshot_then_backfills_once() {
    let (machine, step) = stream::start();
    assert_eq!(step.ask, Some(Ask::Snapshot));
    let (machine, step) = stream::next(
        machine,
        answer(&Said::Snapshot {
            cursor: 450,
            rules: 14,
        }),
        0.5,
    );
    assert_eq!(step.ask, Some(Ask::Stream { after: 250 }));
    let (machine, step) = stream::next(
        machine,
        answer(&Said::Stream {
            cursor: 450,
            events: true,
            resync: false,
            rules: 14,
        }),
        0.5,
    );
    assert_eq!(step.ask, Some(Ask::Stream { after: 450 }));
    // A live event: the snapshot again, then the poll goes on from the event's cursor.
    let (machine, step) = stream::next(
        machine,
        answer(&Said::Stream {
            cursor: 451,
            events: true,
            resync: false,
            rules: 14,
        }),
        0.5,
    );
    assert_eq!(step.ask, Some(Ask::Snapshot));
    let (_, step) = stream::next(
        machine,
        answer(&Said::Snapshot {
            cursor: 451,
            rules: 14,
        }),
        0.5,
    );
    assert_eq!(step.ask, Some(Ask::Stream { after: 451 }));
}

#[test]
fn a_server_without_the_snapshot_route_or_too_new_stops_the_polling() {
    let (machine, _) = stream::start();
    let (_, step) = stream::next(machine.clone(), Answer::Missing, 0.5);
    assert_eq!(step.ask, None);
    let (_, step) = stream::next(machine, Answer::Undecodable, 0.5);
    assert_eq!(step.ask, None);
}

#[test]
fn events_that_land_while_the_snapshot_is_read_again_still_reach_the_feed() {
    let (machine, _) = stream::start();
    let (machine, _) = stream::next(
        machine,
        answer(&Said::Snapshot {
            cursor: 30,
            rules: 14,
        }),
        0.5,
    );
    let (machine, _) = stream::next(
        machine,
        answer(&Said::Stream {
            cursor: 30,
            events: true,
            resync: false,
            rules: 14,
        }),
        0.5,
    );
    // A live batch up to 39: the snapshot again, which another batch has already moved on to 44.
    let (machine, step) = stream::next(
        machine,
        answer(&Said::Stream {
            cursor: 39,
            events: true,
            resync: false,
            rules: 14,
        }),
        0.5,
    );
    assert_eq!(step.ask, Some(Ask::Snapshot));
    let (_, step) = stream::next(
        machine,
        answer(&Said::Snapshot {
            cursor: 44,
            rules: 14,
        }),
        0.5,
    );
    // The poll goes on from 39, so events 40 to 44 are heard, not skipped over.
    assert_eq!(step.ask, Some(Ask::Stream { after: 39 }));
}
