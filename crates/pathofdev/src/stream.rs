//! The stream machine: what to ask the server next, given what it just answered. It is a pure `next(machine, answer)`,
//! so its rules are properties (`tests/stream.rs`), and a thin thread (`run`) that asks and sleeps.
//!
//! ```text
//! GET /v1/snapshot ─▶ cursor = snapshot.cursor
//!   ─▶ backfill: GET /v1/stream?after=max(0, cursor − 200), once, for Today's feed
//! loop: GET /v1/stream?after=cursor
//!   events ─────────────────────▶ the feed; GET /v1/snapshot again, as the mod reads it again; cursor moves
//!   resync / rulesVersion newer ─▶ GET /v1/snapshot, cursor from it
//!   401 ────────────────────────▶ "signed out": waits for a sign-in (online only, PR 3)
//!   429 ────────────────────────▶ waits the time it names, as the mod does
//!   5xx / no answer ────────────▶ offline; asks again after 5 s, doubling to 30 s, with jitter; reset on an answer
//!   404 ────────────────────────▶ "this server is older than pathofdev": polling stops
//!   an answer that won't decode ▶ "this server is newer than pathofdev": polling stops
//! ```
//!
//! A stream poll never names a session: the session is the mod's presence heartbeat, and a poll from here would keep a
//! session live and count toward the parallel missions.

use std::sync::mpsc::Sender;
use std::time::Duration;

use crate::client::{Local, Reply};
use crate::wire::{Event, SnapshotResponse, StreamResponse};

/// How far back the first poll reaches, for the feed: the server keeps a thousand.
pub const BACKFILL: u64 = 200;
/// The first wait after a failure, and the longest.
pub const BACKOFF_MIN_MS: u64 = 5_000;
pub const BACKOFF_MAX_MS: u64 = 30_000;
/// The least and the most a 429 makes the companion wait, whatever it says, as the mod holds it.
pub const LIMITED_MIN_MS: u64 = 1_000;
pub const LIMITED_MAX_MS: u64 = 600_000;

/// A request to the server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ask {
    Snapshot,
    Stream { after: u64 },
}

impl Ask {
    /// The route's path and query.
    pub fn path(self) -> String {
        match self {
            Ask::Snapshot => "/v1/snapshot".to_owned(),
            Ask::Stream { after } => format!("/v1/stream?after={after}"),
        }
    }
}

/// What the server answered, read.
#[derive(Debug, Clone)]
pub enum Answer {
    Snapshot(Box<SnapshotResponse>),
    Stream(StreamResponse),
    /// 429: over a rate limit, for this long.
    Limited {
        wait_ms: u64,
    },
    /// 401.
    SignedOut,
    /// 404: a route this server doesn't have.
    Missing,
    /// A 200 whose body doesn't read as the route's answer.
    Undecodable,
    /// No answer, or one that says the server can't take it now (5xx, or anything else unexpected).
    Down,
}

/// How the companion stands with the server, as the header shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Link {
    Connecting,
    Live,
    /// Asking again in `retry_ms`.
    Offline {
        retry_ms: u64,
    },
    /// Over a rate limit: asking again in `wait_ms`.
    Limited {
        wait_ms: u64,
    },
    SignedOut,
    /// The server has no `/v1/snapshot`: it needs updating.
    ServerOlder,
    /// The server answers what this build can't read: pathofdev needs updating.
    ServerNewer,
}

/// What the screen hears of the stream.
#[derive(Debug, Clone)]
pub enum Update {
    Snapshot(Box<SnapshotResponse>),
    /// Events for the feed: `backfill` for those read once at the start, which happened before the companion ran.
    Events {
        events: Vec<Event>,
        backfill: bool,
    },
    /// The stream started again (another epoch, a reset): the feed marks the gap.
    Resynced,
    Link(Link),
}

/// Where the stream stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Machine {
    /// The last event seen. It only goes back on a resync.
    pub cursor: u64,
    /// The rules version of the snapshot read last.
    pub rules_version: Option<u64>,
    /// Whether the one backfill poll has been asked.
    pub backfilled: bool,
    /// Failures in a row, for the backoff.
    pub failures: u32,
    /// A resync was answered: the next snapshot's cursor is taken as it is, even if it is lower.
    pub resyncing: bool,
    /// What was asked last, asked again after a failure.
    pub asked: Ask,
}

/// What to do next: tell the screen `updates`, wait `wait_ms`, then ask `ask`, or nothing more when it is `None`.
#[derive(Debug, Clone)]
pub struct Step {
    pub updates: Vec<Update>,
    pub wait_ms: u64,
    pub ask: Option<Ask>,
}

/// The machine before anything was asked, and its first ask: the snapshot.
pub fn start() -> (Machine, Step) {
    let machine = Machine {
        cursor: 0,
        rules_version: None,
        backfilled: false,
        failures: 0,
        resyncing: false,
        asked: Ask::Snapshot,
    };
    let step = Step {
        updates: vec![Update::Link(Link::Connecting)],
        wait_ms: 0,
        ask: Some(Ask::Snapshot),
    };
    (machine, step)
}

/// The wait after `failures` failures in a row: 5 s, doubling to 30 s, each lengthened by up to a quarter by `jitter`
/// (0 to 1) so many companions don't knock at once, and never past 30 s.
pub fn backoff_ms(failures: u32, jitter: f64) -> u64 {
    let doublings = failures.saturating_sub(1).min(8);
    let base = (BACKOFF_MIN_MS << doublings).min(BACKOFF_MAX_MS);
    let spread = (base as f64 * jitter.clamp(0.0, 1.0) / 4.0) as u64;
    (base + spread).clamp(BACKOFF_MIN_MS, BACKOFF_MAX_MS)
}

/// The machine after `answer` to what it asked last, and what to do next. `jitter` (0 to 1) spreads the backoff.
pub fn next(mut machine: Machine, answer: Answer, jitter: f64) -> (Machine, Step) {
    let then = |machine: &mut Machine, ask: Ask, updates: Vec<Update>| {
        machine.asked = ask;
        Step {
            updates,
            wait_ms: 0,
            ask: Some(ask),
        }
    };
    let stop = |link: Link| Step {
        updates: vec![Update::Link(link)],
        wait_ms: 0,
        ask: None,
    };
    let step = match answer {
        Answer::Snapshot(response) => {
            machine.failures = 0;
            // The snapshot sets the cursor only the first time and after a resync. Read again after a batch, it may
            // already hold a later one, whose events the feed would never hear if the poll went on from there.
            if machine.resyncing {
                machine.cursor = response.snapshot.cursor;
            } else if machine.rules_version.is_none() {
                machine.cursor = machine.cursor.max(response.snapshot.cursor);
            }
            machine.resyncing = false;
            machine.rules_version = Some(response.rules.version);
            let ask = if machine.backfilled {
                Ask::Stream {
                    after: machine.cursor,
                }
            } else {
                Ask::Stream {
                    after: machine.cursor.saturating_sub(BACKFILL),
                }
            };
            then(
                &mut machine,
                ask,
                vec![Update::Link(Link::Live), Update::Snapshot(response)],
            )
        }
        Answer::Stream(response) => {
            machine.failures = 0;
            let backfill = !machine.backfilled;
            machine.backfilled = true;
            let mut updates = vec![Update::Link(Link::Live)];
            if response.resync == Some(true) {
                machine.resyncing = true;
                updates.push(Update::Resynced);
                then(&mut machine, Ask::Snapshot, updates)
            } else {
                let newer_rules = machine
                    .rules_version
                    .is_some_and(|known| response.rules_version > known);
                // The backfill reads events the snapshot already holds: only those past its cursor changed the state.
                let changed = response.cursor > machine.cursor;
                machine.cursor = machine.cursor.max(response.cursor);
                if !response.events.is_empty() {
                    updates.push(Update::Events {
                        events: response.events,
                        backfill,
                    });
                }
                let ask = if newer_rules || changed {
                    Ask::Snapshot
                } else {
                    Ask::Stream {
                        after: machine.cursor,
                    }
                };
                then(&mut machine, ask, updates)
            }
        }
        Answer::Limited { wait_ms } => {
            let wait_ms = wait_ms.clamp(LIMITED_MIN_MS, LIMITED_MAX_MS);
            Step {
                updates: vec![Update::Link(Link::Limited { wait_ms })],
                wait_ms,
                ask: Some(machine.asked),
            }
        }
        Answer::Down => {
            machine.failures = machine.failures.saturating_add(1);
            let retry_ms = backoff_ms(machine.failures, jitter);
            Step {
                updates: vec![Update::Link(Link::Offline { retry_ms })],
                wait_ms: retry_ms,
                ask: Some(machine.asked),
            }
        }
        Answer::SignedOut => stop(Link::SignedOut),
        Answer::Missing => stop(Link::ServerOlder),
        Answer::Undecodable => stop(Link::ServerNewer),
    };
    (machine, step)
}

/// Reads a reply to `ask` as the machine's answer.
pub fn answer_of(ask: Ask, reply: &Reply) -> Answer {
    match reply.status {
        200 => match ask {
            Ask::Snapshot => serde_json::from_str::<SnapshotResponse>(&reply.body)
                .map(|response| Answer::Snapshot(Box::new(response)))
                .unwrap_or(Answer::Undecodable),
            Ask::Stream { .. } => serde_json::from_str::<StreamResponse>(&reply.body)
                .map(Answer::Stream)
                .unwrap_or(Answer::Undecodable),
        },
        401 => Answer::SignedOut,
        404 => Answer::Missing,
        429 => Answer::Limited {
            wait_ms: retry_after_ms(reply),
        },
        _ => Answer::Down,
    }
}

/// How long a 429 asks to wait, as the mod reads it (`retryAfterOf`): its body's `retryAfterMs`, else its `Retry-After`
/// in seconds, else a minute. The machine holds it between a second and ten minutes.
pub fn retry_after_ms(reply: &Reply) -> u64 {
    let asked = serde_json::from_str::<serde_json::Value>(&reply.body)
        .ok()
        .and_then(|body| body.get("retryAfterMs").and_then(serde_json::Value::as_f64));
    let header = reply
        .retry_after
        .as_deref()
        .and_then(|text| text.trim().parse::<f64>().ok())
        .map(|s| s * 1_000.0);
    let ms = asked
        .or(header)
        .filter(|ms| ms.is_finite())
        .unwrap_or(60_000.0);
    ms.clamp(0.0, LIMITED_MAX_MS as f64).ceil() as u64
}

/// A number from 0 to 1 that differs from call to call, for the backoff's jitter: std's hasher keys are random per
/// process and per `RandomState`, which is all the randomness a jitter needs.
pub fn jitter() -> f64 {
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u64(0);
    (hasher.finish() >> 11) as f64 / (1u64 << 53) as f64
}

/// The stream thread: asks, reads, tells the screen, sleeps, until the machine stops or the screen is gone.
pub fn run(mut local: Local, updates: Sender<Update>) {
    let (mut machine, mut step) = start();
    loop {
        for update in step.updates.drain(..) {
            if updates.send(update).is_err() {
                return;
            }
        }
        std::thread::sleep(Duration::from_millis(step.wait_ms));
        let Some(ask) = step.ask else { return };
        let answer = match local.get(&ask.path()) {
            Ok(reply) => answer_of(ask, &reply),
            Err(_) => Answer::Down,
        };
        (machine, step) = next(machine, answer, jitter());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(status: u16, body: &str, retry_after: Option<&str>) -> Reply {
        Reply {
            status,
            body: body.to_owned(),
            retry_after: retry_after.map(str::to_owned),
        }
    }

    #[test]
    fn a_stream_poll_never_names_a_session() {
        assert_eq!(Ask::Stream { after: 7 }.path(), "/v1/stream?after=7");
    }

    #[test]
    fn reads_a_429_as_the_mod_does() {
        assert_eq!(
            retry_after_ms(&reply(429, r#"{"retryAfterMs":2500}"#, Some("9"))),
            2_500
        );
        assert_eq!(retry_after_ms(&reply(429, "", Some("9"))), 9_000);
        assert_eq!(retry_after_ms(&reply(429, "", None)), 60_000);
        assert!(matches!(
            answer_of(Ask::Snapshot, &reply(429, "", Some("3"))),
            Answer::Limited { wait_ms: 3_000 }
        ));
    }

    #[test]
    fn names_what_each_status_means() {
        assert!(matches!(
            answer_of(Ask::Snapshot, &reply(404, "", None)),
            Answer::Missing
        ));
        assert!(matches!(
            answer_of(Ask::Snapshot, &reply(401, "", None)),
            Answer::SignedOut
        ));
        assert!(matches!(
            answer_of(Ask::Snapshot, &reply(503, "", None)),
            Answer::Down
        ));
        assert!(matches!(
            answer_of(Ask::Snapshot, &reply(200, "{}", None)),
            Answer::Undecodable
        ));
        assert!(matches!(
            answer_of(Ask::Stream { after: 0 }, &reply(200, "[]", None)),
            Answer::Undecodable
        ));
    }

    #[test]
    fn jitter_stays_between_0_and_1() {
        assert!((0..100).map(|_| jitter()).all(|j| (0.0..1.0).contains(&j)));
    }
}
