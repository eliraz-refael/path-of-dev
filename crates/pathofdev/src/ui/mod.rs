//! The screen: a header, the tabs, a rule, then the tab's body, with a notice above it while the server isn't live
//! and the keys over it on `?`.
//!
//! ```text
//!  ✦ PATH OF DEV ✦  Player · Lv 28 Artisan · 120 gold                     local · ● live
//!  1 Home  2 Missions  3 Loot  4 Stats
//!  ──────────────────────────────────────────────────────────────────────────────────
//!  (the tab)
//! ```
//!
//! Below 40×16 it draws only "Make this pane bigger".

pub mod app;
pub mod feed;
pub mod home;
pub mod sprite;
pub mod theme;

use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};

use jiff::Timestamp;
use jiff::tz::TimeZone;
use ratatui::DefaultTerminal;
use ratatui::buffer::Buffer;
use ratatui::crossterm::event::{self, Event};
use ratatui::layout::{Alignment, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Clear, Paragraph, Widget};

use self::app::{App, Tab};
use self::theme::{ACCENT, DIM, GOOD, WARN};
use crate::stream::{Link, Update};

pub const MIN_WIDTH: u16 = 40;
pub const MIN_HEIGHT: u16 = 16;

/// The rows above the body: the header, the tabs and the rule.
const CHROME: u16 = 3;

/// Draws the whole screen for `app` into `buf`.
pub fn render(app: &App, area: Rect, buf: &mut Buffer) {
    if area.width < MIN_WIDTH || area.height < MIN_HEIGHT {
        too_small(app, area, buf);
        return;
    }
    header(app, Rect { height: 1, ..area }, buf);
    tabs(
        app,
        Rect {
            y: area.y + 1,
            height: 1,
            ..area
        },
        buf,
    );
    let rule = "─".repeat(usize::from(area.width.saturating_sub(2)));
    Paragraph::new(Line::styled(rule, dim(app))).render(
        Rect {
            x: area.x + 1,
            y: area.y + 2,
            height: 1,
            ..area
        },
        buf,
    );
    let mut body = Rect {
        y: area.y + CHROME,
        height: area.height - CHROME,
        ..area
    };
    if let Some(text) = notice(app) {
        let lines: Vec<Line> = wrap(&text, usize::from(body.width.saturating_sub(2)))
            .into_iter()
            .map(|line| Line::styled(line, warn(app)))
            .collect();
        let height = u16::try_from(lines.len())
            .unwrap_or(u16::MAX)
            .min(body.height);
        Paragraph::new(lines).render(
            Rect {
                x: body.x + 1,
                width: body.width.saturating_sub(2),
                height,
                ..body
            },
            buf,
        );
        body.y += height;
        body.height -= height;
    }
    match app.tab {
        Tab::Home => home::draw(app, body, buf),
        tab => coming_soon(app, tab, body, buf),
    }
    if app.help {
        help(app, area, buf);
    }
}

fn dim(app: &App) -> Style {
    Style::new().fg(app.theme.paint(DIM))
}

fn warn(app: &App) -> Style {
    Style::new().fg(app.theme.paint(WARN))
}

fn too_small(app: &App, area: Rect, buf: &mut Buffer) {
    let lines = vec![
        Line::raw("Make this pane bigger"),
        Line::styled(format!("(at least {MIN_WIDTH}×{MIN_HEIGHT})"), dim(app)),
    ];
    let top = area.y + area.height.saturating_sub(2) / 2;
    let rect = Rect {
        y: top,
        height: area.height.min(2),
        ..area
    };
    Paragraph::new(lines)
        .alignment(Alignment::Center)
        .render(rect, buf);
}

/// The game's name and the character on the left; where the companion is connected on the right, which stays whole
/// when the pane is narrow, so the left gives way.
fn header(app: &App, area: Rect, buf: &mut Buffer) {
    let mut left = vec![vec![Span::styled(
        " ✦ PATH OF DEV ✦",
        Style::new()
            .fg(app.theme.paint(ACCENT))
            .add_modifier(Modifier::BOLD),
    )]];
    if let Some(response) = &app.snapshot {
        let character = &response.snapshot.character;
        left.push(vec![Span::raw(format!("  {}", character.name))]);
        left.push(vec![
            Span::raw(" · "),
            Span::styled(
                format!("Lv {}", character.level),
                Style::new().fg(app.theme.paint(ACCENT)),
            ),
            Span::raw(format!(" {}", character.title)),
        ]);
        left.push(vec![Span::raw(format!(
            " · {} gold",
            count(character.gold)
        ))]);
    }
    let (word, style) = link_words(app);
    let right = Line::from(vec![
        Span::styled(format!("{} · ", app.target.label()), dim(app)),
        Span::styled(word, style),
        Span::raw(" "),
    ]);
    let right_width = u16::try_from(right.width())
        .unwrap_or(u16::MAX)
        .min(area.width);
    let left_area = Rect {
        width: area.width.saturating_sub(right_width + 1),
        ..area
    };
    Paragraph::new(fit(left, usize::from(left_area.width))).render(left_area, buf);
    let right_area = Rect {
        x: area.right() - right_width,
        width: right_width,
        ..area
    };
    Paragraph::new(right).render(right_area, buf);
}

/// The link in a word or two, for the header.
fn link_words(app: &App) -> (String, Style) {
    match app.link {
        Link::Connecting => ("connecting".to_owned(), dim(app)),
        Link::Live => ("● live".to_owned(), Style::new().fg(app.theme.paint(GOOD))),
        Link::Offline { .. } => ("offline".to_owned(), warn(app)),
        Link::Limited { .. } => ("busy".to_owned(), warn(app)),
        Link::SignedOut => ("signed out".to_owned(), warn(app)),
        Link::ServerOlder => ("update the server".to_owned(), warn(app)),
        Link::ServerNewer => ("update pathofdev".to_owned(), warn(app)),
    }
}

/// What the player should know about the link, above the tab, when it isn't live.
fn notice(app: &App) -> Option<String> {
    let retry = || {
        let seconds = app.retry_at.map_or(0, |at| {
            ((at.as_millisecond() - app.now.as_millisecond()).max(0) + 999) / 1_000
        });
        if seconds == 0 {
            "Trying again now.".to_owned()
        } else {
            format!("Trying again in {seconds} s.")
        }
    };
    let target = app.target.label();
    Some(match app.link {
        Link::Connecting | Link::Live => return None,
        Link::Offline { .. } => {
            format!(
                "The {target} server isn't answering: start it with {}. {}",
                app.target.start_command(),
                retry()
            )
        }
        Link::Limited { .. } => format!("The {target} server is busy. {}", retry()),
        Link::SignedOut => {
            "Signed out: /pathofdev login in Claude Code signs you in again.".to_owned()
        }
        Link::ServerOlder => {
            format!(
                "This {target} server is older than pathofdev: update it (git pull), then start it again."
            )
        }
        Link::ServerNewer => format!(
            "This {target} server is newer than pathofdev {}: update pathofdev to watch it.",
            env!("CARGO_PKG_VERSION")
        ),
    })
}

fn tabs(app: &App, area: Rect, buf: &mut Buffer) {
    let mut spans = vec![Span::raw(" ")];
    for (index, tab) in Tab::ALL.iter().enumerate() {
        if index > 0 {
            spans.push(Span::raw("  "));
        }
        spans.push(Span::styled(
            format!("{}", index + 1),
            Style::new().fg(app.theme.paint(ACCENT)),
        ));
        spans.push(Span::raw(" "));
        let style = if *tab == app.tab {
            Style::new().add_modifier(Modifier::BOLD | Modifier::UNDERLINED)
        } else {
            dim(app)
        };
        spans.push(Span::styled(tab.name(), style));
    }
    Paragraph::new(Line::from(spans)).render(area, buf);
}

fn coming_soon(app: &App, tab: Tab, area: Rect, buf: &mut Buffer) {
    let lines = vec![
        Line::raw(""),
        Line::raw(format!("The {} tab is coming soon.", tab.name())),
        Line::styled("Until then, the pane in Claude Code has it all.", dim(app)),
    ];
    Paragraph::new(lines)
        .alignment(Alignment::Center)
        .render(area, buf);
}

fn help(app: &App, area: Rect, buf: &mut Buffer) {
    let rows = [
        ("1–4  ← →", "switch tabs"),
        ("?", "show or hide the keys"),
        ("q", "quit"),
        ("Esc", "close this, then quit"),
    ];
    let lines: Vec<Line> = rows
        .iter()
        .map(|(keys, what)| {
            Line::from(vec![
                Span::styled(
                    format!(" {keys:<10}"),
                    Style::new().fg(app.theme.paint(ACCENT)),
                ),
                Span::raw(*what),
            ])
        })
        .collect();
    let width = 36.min(area.width);
    let height = (u16::try_from(lines.len()).unwrap_or(0) + 2).min(area.height);
    let rect = Rect {
        x: area.x + (area.width - width) / 2,
        y: area.y + (area.height - height) / 2,
        width,
        height,
    };
    Clear.render(rect, buf);
    Paragraph::new(lines)
        .block(Block::bordered().title(" Keys ").border_style(dim(app)))
        .render(rect, buf);
}

/// A count with its thousands set apart: `3,155`.
pub fn count(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, digit) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// A span of time as the player reads it: `2d 4h`, `9h 12m`, `12m`, `under a minute`.
pub fn duration_words(seconds: i64) -> String {
    let minutes = seconds.max(0) / 60;
    let (days, hours, minutes) = (minutes / 1_440, minutes / 60 % 24, minutes % 60);
    if days > 0 {
        format!("{days}d {hours}h")
    } else if hours > 0 {
        format!("{hours}h {minutes}m")
    } else if minutes > 0 {
        format!("{minutes}m")
    } else {
        "under a minute".to_owned()
    }
}

/// `14:02`, in the player's time zone.
pub fn local_time(at: Timestamp, zone: &TimeZone) -> String {
    at.to_zoned(zone.clone()).strftime("%H:%M").to_string()
}

/// `text` broken at spaces into lines of at most `width` cells; a word longer than that is cut.
pub fn wrap(text: &str, width: usize) -> Vec<String> {
    let width = width.max(1);
    let mut lines = Vec::new();
    let mut line = String::new();
    for word in text.split(' ').filter(|word| !word.is_empty()) {
        let word: String = word.chars().take(width).collect();
        let needed = if line.is_empty() {
            cells(&word)
        } else {
            cells(&line) + 1 + cells(&word)
        };
        if needed > width && !line.is_empty() {
            lines.push(std::mem::take(&mut line));
        }
        if !line.is_empty() {
            line.push(' ');
        }
        line.push_str(&word);
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
}

/// The cells `text` takes, measured as ratatui measures it.
fn cells(text: &str) -> usize {
    Span::raw(text).width()
}

/// The `parts` of a line that fit in `width` cells: the first always (cut, if it must be), each later one only whole
/// and only while every one before it fit, so a narrow pane loses the least of each line, never half a word.
pub fn fit(parts: Vec<Vec<Span<'static>>>, width: impl Into<usize>) -> Line<'static> {
    let width = width.into();
    let mut spans = Vec::new();
    let mut used = 0;
    for (index, part) in parts.into_iter().enumerate() {
        let cells: usize = part.iter().map(Span::width).sum();
        if index > 0 && used + cells > width {
            break;
        }
        used += cells;
        spans.extend(part);
    }
    Line::from(spans)
}

/// A drawn buffer as plain text, a line per row with its trailing spaces cut: what the screen tests compare. A wide
/// glyph's second cell holds nothing of its own, so it is passed over.
pub fn text_of(buf: &Buffer) -> String {
    let area = buf.area;
    let mut out = String::new();
    for y in area.top()..area.bottom() {
        let mut row = String::new();
        let mut covered = area.left();
        for x in area.left()..area.right() {
            if x < covered {
                continue;
            }
            let symbol = buf[(x, y)].symbol();
            row.push_str(symbol);
            covered = x + u16::try_from(cells(symbol).max(1)).unwrap_or(1);
        }
        out.push_str(row.trim_end());
        out.push('\n');
    }
    out
}

/// The screen's loop: keys and resizes from the terminal, updates from the stream, a draw when anything changed and
/// each second for the timers, until `q`.
pub fn run(
    terminal: &mut DefaultTerminal,
    app: &mut App,
    updates: &Receiver<Update>,
) -> std::io::Result<()> {
    let mut dirty = true;
    let mut drawn = Instant::now();
    while !app.quit {
        if dirty || drawn.elapsed() >= Duration::from_secs(1) {
            app.now = Timestamp::now();
            terminal.draw(|frame| render(app, frame.area(), frame.buffer_mut()))?;
            drawn = Instant::now();
            dirty = false;
        }
        if event::poll(Duration::from_millis(250))? {
            match event::read()? {
                Event::Key(key) => app.key(key),
                Event::Resize(..) => {}
                _ => continue,
            }
            dirty = true;
        }
        // The stream thread stops for good on an answer it can't go past; the screen stays, saying why.
        while let Ok(update) = updates.try_recv() {
            app.now = Timestamp::now();
            app.apply(update);
            dirty = true;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sets_thousands_apart() {
        assert_eq!(
            (count(0), count(999), count(3155), count(1234567)),
            ("0".into(), "999".into(), "3,155".into(), "1,234,567".into())
        );
    }

    #[test]
    fn words_a_span_of_time() {
        assert_eq!(duration_words(9 * 3600 + 12 * 60 + 30), "9h 12m");
        assert_eq!(duration_words(2 * 86_400 + 4 * 3600), "2d 4h");
        assert_eq!(duration_words(59), "under a minute");
        assert_eq!(duration_words(-5), "under a minute");
    }

    #[test]
    fn wraps_at_spaces_within_the_width() {
        assert_eq!(
            wrap("the local server isn't answering", 12),
            ["the local", "server isn't", "answering"]
        );
        assert_eq!(wrap("abcdefghij", 4), ["abcd"]);
        assert!(wrap("a b c", 10).iter().all(|line| cells(line) <= 10));
    }
}
