//! Today's feed: what the stream said, newest first, one line each, as the Home tab lists it under "Today".
//!
//! The backfill and the live polls can overlap, so an event is kept once, by its `seq`. Only the latest seqs are
//! remembered, and any older one counts as seen: the stream's seqs only grow, until a resync starts the numbers again,
//! when what was seen is forgotten and a gap line marks where the stream started over.

use std::collections::BTreeSet;

use jiff::Timestamp;

use crate::wire::{Event, EventBody};

/// The most lines kept: more than a day of play scrolls off the top long before.
const KEEP: usize = 300;

/// The most seqs remembered: far more than a poll's overlap with the one before (the backfill's 200).
const REMEMBER: usize = 1_000;

/// One line of the feed.
#[derive(Debug, Clone, PartialEq)]
pub enum Entry {
    Xp {
        amount: u64,
        reason: String,
        grade: Option<f64>,
    },
    /// One or more level-ups from one cause, as one line: a big grant climbs several at once.
    Level {
        from: u64,
        to: u64,
        title: Option<String>,
    },
    Loot {
        name: String,
        rarity: String,
    },
    Progress {
        quest_id: String,
        progress: u64,
        goal: u64,
    },
    Done {
        title: String,
    },
    Badge {
        title: String,
    },
    Hatched {
        name: String,
    },
    /// The stream started again; what happened between is in the snapshot, not here.
    Gap,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Line {
    pub at: Timestamp,
    pub cause: Option<String>,
    pub entry: Entry,
}

#[derive(Debug, Clone, Default)]
pub struct Feed {
    /// Oldest first.
    lines: Vec<Line>,
    seen: BTreeSet<u64>,
    /// The highest seq forgotten: none at or under it is taken again.
    forgotten: Option<u64>,
}

impl Feed {
    /// Adds the events it hasn't seen, in stream order.
    pub fn push(&mut self, events: &[Event]) {
        for event in events {
            if self.forgotten.is_some_and(|floor| event.seq <= floor)
                || !self.seen.insert(event.seq)
            {
                continue;
            }
            let Some(entry) = entry_of(&event.body) else {
                continue;
            };
            // An event whose time doesn't read is dropped rather than shown at a made-up one.
            let Ok(at) = event.at.as_str().parse::<Timestamp>() else {
                continue;
            };
            let cause = event.cause.as_ref().map(|cause| cause.as_str().to_owned());
            if let (Entry::Level { to, title, .. }, Some(last)) = (&entry, self.lines.last_mut())
                && let Entry::Level {
                    to: last_to,
                    title: last_title,
                    ..
                } = &mut last.entry
                && cause.is_some()
                && last.cause == cause
            {
                *last_to = *to;
                if title.is_some() {
                    last_title.clone_from(title);
                }
                continue;
            }
            self.lines.push(Line { at, cause, entry });
        }
        if self.lines.len() > KEEP {
            self.lines.drain(..self.lines.len() - KEEP);
        }
        while self.seen.len() > REMEMBER {
            self.forgotten = self.seen.pop_first().max(self.forgotten);
        }
    }

    /// The stream started again at `at`.
    pub fn gap(&mut self, at: Timestamp) {
        self.seen.clear();
        self.forgotten = None;
        if self
            .lines
            .last()
            .is_some_and(|line| line.entry != Entry::Gap)
        {
            self.lines.push(Line {
                at,
                cause: None,
                entry: Entry::Gap,
            });
        }
    }

    /// Newest first.
    pub fn newest(&self) -> impl Iterator<Item = &Line> {
        self.lines.iter().rev()
    }

    /// The last graded prompt: its grade and the XP it earned.
    pub fn last_prompt(&self) -> Option<(f64, u64)> {
        self.newest().find_map(|line| match &line.entry {
            Entry::Xp {
                amount,
                reason,
                grade: Some(grade),
            } if reason == "prompt.graded" => Some((*grade, *amount)),
            _ => None,
        })
    }
}

fn entry_of(body: &EventBody) -> Option<Entry> {
    Some(match body {
        EventBody::XpGranted(xp) => Entry::Xp {
            amount: xp.amount,
            reason: xp.reason.to_string(),
            grade: xp.grade,
        },
        EventBody::LevelUp(up) => Entry::Level {
            from: up.from,
            to: up.to,
            title: up.title.as_ref().map(ToString::to_string),
        },
        EventBody::LootDropped(loot) => Entry::Loot {
            name: loot.item.name.to_string(),
            rarity: loot.item.rarity.to_string(),
        },
        EventBody::QuestProgress(quest) => Entry::Progress {
            quest_id: quest.quest_id.to_string(),
            progress: quest.progress,
            goal: quest.goal,
        },
        EventBody::QuestCompleted(quest) => Entry::Done {
            title: quest.title.to_string(),
        },
        EventBody::AchievementUnlocked(badge) => Entry::Badge {
            title: badge.title.to_string(),
        },
        EventBody::PetHatched(pet) => Entry::Hatched {
            name: pet.name.to_string(),
        },
        EventBody::Other => return None,
    })
}

/// A scoring fact as the feed words it.
pub fn reason_words(reason: &str) -> &str {
    match reason {
        "prompt.graded" => "prompt",
        "commit.made" => "commit",
        "change.merged" => "merged",
        "change.opened" => "change opened",
        "bug.fixed" => "bug fixed",
        "issue.closed" => "issue closed",
        "repo.explored" => "explored",
        "review.acted_on" => "review",
        "streak.day" => "streak",
        "tests.green" => "tests green",
        "first.contribution" => "first contribution",
        "quest" => "mission",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{LevelUp, Text, XpGranted};

    fn event(seq: u64, cause: Option<&str>, body: EventBody) -> Event {
        Event {
            seq,
            at: Text::new("2026-10-09T08:00:00.000Z"),
            cause: cause.map(Text::new),
            body,
        }
    }

    fn xp(amount: u64) -> EventBody {
        EventBody::XpGranted(XpGranted {
            amount,
            reason: Text::new("prompt.graded"),
            grade: Some(8.2),
            sigil: None,
        })
    }

    fn level(from: u64, to: u64) -> EventBody {
        EventBody::LevelUp(LevelUp {
            from,
            to,
            title: None,
        })
    }

    #[test]
    fn keeps_an_event_once_though_two_polls_bring_it() {
        let mut feed = Feed::default();
        feed.push(&[event(1, None, xp(12)), event(2, None, xp(13))]);
        feed.push(&[event(2, None, xp(13)), event(3, None, xp(14))]);
        assert_eq!(feed.newest().count(), 3);
        assert_eq!(feed.last_prompt(), Some((8.2, 14)));
    }

    #[test]
    fn folds_the_level_ups_of_one_cause_into_a_line() {
        let mut feed = Feed::default();
        feed.push(&[
            event(1, Some("a"), level(1, 2)),
            event(2, Some("a"), level(2, 3)),
            event(3, Some("b"), level(3, 4)),
        ]);
        let levels: Vec<_> = feed.newest().map(|line| line.entry.clone()).collect();
        assert_eq!(
            levels,
            [
                Entry::Level {
                    from: 3,
                    to: 4,
                    title: None
                },
                Entry::Level {
                    from: 1,
                    to: 3,
                    title: None
                }
            ]
        );
    }

    #[test]
    fn remembers_only_the_latest_seqs_and_still_takes_an_old_one_once() {
        let mut feed = Feed::default();
        let events: Vec<Event> = (1..=1_500).map(|seq| event(seq, None, xp(1))).collect();
        feed.push(&events);
        assert!(feed.seen.len() <= REMEMBER, "{} seqs held", feed.seen.len());
        let before = feed.newest().count();
        feed.push(&[event(1, None, xp(1)), event(1_400, None, xp(1))]);
        assert_eq!(
            feed.newest().count(),
            before,
            "an old event was taken again"
        );
        feed.push(&[event(1_501, None, xp(1))]);
        assert_eq!(feed.newest().count(), before);
        assert_eq!(feed.seen.last(), Some(&1_501));

        feed.gap(Timestamp::UNIX_EPOCH);
        feed.push(&[event(1, None, xp(1))]);
        assert_eq!(
            feed.seen.first(),
            Some(&1),
            "a resync forgets the floor too"
        );
    }

    #[test]
    fn hears_the_same_seq_again_after_a_resync() {
        let mut feed = Feed::default();
        feed.push(&[event(1, None, xp(12))]);
        feed.gap(Timestamp::UNIX_EPOCH);
        feed.push(&[event(1, None, xp(20))]);
        let entries: Vec<_> = feed.newest().map(|line| line.entry.clone()).collect();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[1], Entry::Gap);
    }
}
