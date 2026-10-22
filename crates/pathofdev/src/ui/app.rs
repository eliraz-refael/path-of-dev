//! What the screen shows, and how keys and the stream change it. Drawing reads it and changes nothing.

use jiff::Timestamp;
use jiff::tz::TimeZone;
use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

use super::feed::Feed;
use super::sprite::Sprite;
use super::theme::Theme;
use crate::stream::{Link, Update};
use crate::wire::SnapshotResponse;

/// The tabs, in the order the keys `1` to `4` pick them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tab {
    Home,
    Missions,
    Loot,
    Stats,
}

impl Tab {
    pub const ALL: [Tab; 4] = [Tab::Home, Tab::Missions, Tab::Loot, Tab::Stats];

    pub fn name(self) -> &'static str {
        match self {
            Tab::Home => "Home",
            Tab::Missions => "Missions",
            Tab::Loot => "Loot",
            Tab::Stats => "Stats",
        }
    }

    fn index(self) -> usize {
        Tab::ALL.iter().position(|tab| *tab == self).unwrap_or(0)
    }

    /// The tab `by` places along, wrapping around.
    fn moved(self, by: isize) -> Tab {
        let count = Tab::ALL.len() as isize;
        Tab::ALL[(self.index() as isize + by).rem_euclid(count) as usize]
    }
}

/// Which local server the companion watches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Local,
    /// The dev sandbox, `PATHOFDEV_DEV=1`.
    Dev,
}

impl Target {
    pub fn label(self) -> &'static str {
        match self {
            Target::Local => "local",
            Target::Dev => "dev",
        }
    }

    /// How the player starts it, from the repo.
    pub fn start_command(self) -> &'static str {
        match self {
            Target::Local => "pnpm --filter @pathofdev/server start",
            Target::Dev => "PATHOFDEV_DEV=1 pnpm --filter @pathofdev/server start",
        }
    }
}

pub struct App {
    pub tab: Tab,
    pub help: bool,
    pub quit: bool,
    pub target: Target,
    pub link: Link,
    /// When the companion asks again, while it waits after a failure or a 429.
    pub retry_at: Option<Timestamp>,
    pub snapshot: Option<SnapshotResponse>,
    pub feed: Feed,
    pub sprite: Sprite,
    pub theme: Theme,
    /// The time the screen is drawn for, moved on by the loop: tests fix it.
    pub now: Timestamp,
    pub zone: TimeZone,
}

impl App {
    pub fn new(
        target: Target,
        sprite: Sprite,
        theme: Theme,
        now: Timestamp,
        zone: TimeZone,
    ) -> Self {
        App {
            tab: Tab::Home,
            help: false,
            quit: false,
            target,
            link: Link::Connecting,
            retry_at: None,
            snapshot: None,
            feed: Feed::default(),
            sprite,
            theme,
            now,
            zone,
        }
    }

    /// What the stream said.
    pub fn apply(&mut self, update: Update) {
        match update {
            Update::Snapshot(response) => self.snapshot = Some(*response),
            Update::Events { events, .. } => self.feed.push(&events),
            Update::Resynced => self.feed.gap(self.now),
            Update::Link(link) => {
                let wait = match link {
                    Link::Offline { retry_ms, .. } => Some(retry_ms),
                    Link::Limited { wait_ms } => Some(wait_ms),
                    _ => None,
                };
                self.retry_at = wait.and_then(|ms| {
                    self.now
                        .checked_add(jiff::SignedDuration::from_millis(ms as i64))
                        .ok()
                });
                self.link = link;
            }
        }
    }

    /// What a key does. Esc closes the keys first, and quits only when they aren't shown.
    pub fn key(&mut self, key: KeyEvent) {
        if key.kind == KeyEventKind::Release {
            return;
        }
        match key.code {
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => self.quit = true,
            KeyCode::Char('q') => self.quit = true,
            KeyCode::Esc if self.help => self.help = false,
            KeyCode::Esc => self.quit = true,
            KeyCode::Char('?') => self.help = !self.help,
            KeyCode::Char(digit @ '1'..='4') => {
                self.tab = Tab::ALL[usize::from(digit as u8 - b'1')];
                self.help = false;
            }
            KeyCode::Right | KeyCode::Tab => self.tab = self.tab.moved(1),
            KeyCode::Left | KeyCode::BackTab => self.tab = self.tab.moved(-1),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::crossterm::event::KeyEvent;

    fn app() -> App {
        let sprite = Sprite {
            rows: vec![],
            palette: Default::default(),
        };
        App::new(
            Target::Local,
            sprite,
            Theme { truecolor: true },
            Timestamp::UNIX_EPOCH,
            TimeZone::UTC,
        )
    }

    fn press(app: &mut App, code: KeyCode) {
        app.key(KeyEvent::from(code));
    }

    #[test]
    fn switches_tabs_by_number_and_arrow() {
        let mut app = app();
        press(&mut app, KeyCode::Char('3'));
        assert_eq!(app.tab, Tab::Loot);
        press(&mut app, KeyCode::Right);
        press(&mut app, KeyCode::Right);
        assert_eq!(app.tab, Tab::Home);
        press(&mut app, KeyCode::Left);
        assert_eq!(app.tab, Tab::Stats);
    }

    #[test]
    fn esc_closes_the_keys_before_it_quits() {
        let mut app = app();
        press(&mut app, KeyCode::Char('?'));
        assert!(app.help);
        press(&mut app, KeyCode::Esc);
        assert!(!app.help && !app.quit);
        press(&mut app, KeyCode::Esc);
        assert!(app.quit);
        let mut app = super::tests::app();
        press(&mut app, KeyCode::Char('q'));
        assert!(app.quit);
    }

    #[test]
    fn counts_down_to_the_next_try_while_offline() {
        let mut app = app();
        app.apply(Update::Link(Link::Offline {
            retry_ms: 12_000,
            status: None,
        }));
        assert_eq!(app.retry_at, Some(Timestamp::from_second(12).unwrap()));
        app.apply(Update::Link(Link::Live));
        assert_eq!(app.retry_at, None);
    }
}
