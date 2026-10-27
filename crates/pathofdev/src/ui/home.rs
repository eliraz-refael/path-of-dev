//! The Home tab: the pet with its facts beside it, the last graded prompt, and Today's feed.
//!
//! ```text
//!  ▄▀▀▄        ▄▀▀▄      Pixel · form 2 · happy ♥♥♥♥♥
//!  █▀▀▀█▄▄▄▄▄▄█▀▀▀█
//!  ███▀▀████▀▀███████    Lv 28  ██░░░░░░░░░░░░░░  113 / 1,514
//!   …                    Streak 1 day · 1 rest day left
//!                        Sigil ✹ ×2 worn
//!
//!                        Running: Pinpoint 2/3 · ends in 15h 59m
//!  Last prompt · 8.2 · +12 XP
//!  Today
//!  08:00  +12 XP   prompt 8.2
//!  08:00  ◆ epic   Arcane Sigil dropped
//! ```
//!
//! The pet is 2× (28×12 cells) when the pane has room, else 1× (14×6), with the facts drawn tighter beside it. A pet
//! in a scene stands in it at 1×, the scene 48×12 cells, or the part of it round the pet that leaves the facts room;
//! a short pane keeps the scene's lower half, where the pet stands.

use jiff::Timestamp;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Paragraph, Widget};

use super::app::App;
use super::feed::{self, Entry};
use super::scene::Scenes;
use super::theme::{ACCENT, DIM, EMPTY, GOOD, PINK, WARN};
use super::{count, duration_words, fit, local_time};
use crate::stream::Link;
use crate::wire::{Quest, Snapshot, SnapshotResponse};

/// The pet is drawn at 2× from this wide and this tall a body.
const BIG_WIDTH: u16 = 64;
const BIG_HEIGHT: u16 = 18;
/// What a scene leaves the facts beside it: the columns they keep, and the scene the least it draws, the pet's width.
const FACTS_ROOM: u16 = 34;
const SCENE_LEAST: u16 = 14;
/// A body shorter than `BIG_HEIGHT` draws a scene from this row of cells down: the pet and the ground it stands on.
const SHORT_SCENE_FROM: usize = 5;

pub fn draw(app: &App, area: Rect, buf: &mut Buffer) {
    let Some(response) = &app.snapshot else {
        if app.link == Link::Connecting {
            let text = format!("Reading your game from the {} server…", app.target.label());
            Paragraph::new(Line::styled(text, dim(app))).render(inset(area), buf);
        }
        return;
    };
    let big = area.width >= BIG_WIDTH && area.height >= BIG_HEIGHT;
    let scale = if big { 2 } else { 1 };
    let snapshot = &response.snapshot;
    let scenes = Scenes::embedded();
    let scene = snapshot.pet.as_ref().and_then(|_| scenes.worn(snapshot));
    // The pet in the scene it wears, as much of it as leaves the facts their room, or on its own, as big as fits.
    let pet_lines = match scene {
        Some(art) => {
            // A tall pane draws the whole height of the scene, so the facts sit 4 from it rather than 2.
            let tall = area.height >= BIG_HEIGHT;
            let gap = if tall { 4 } else { 2 };
            let room = area.width.saturating_sub(2 + gap + FACTS_ROOM);
            let width = room.clamp(SCENE_LEAST, scenes.cells().0);
            let lines = scenes.lines(art, &app.sprite, app.now, width, app.theme);
            let skip = if tall { 0 } else { SHORT_SCENE_FROM };
            lines.into_iter().skip(skip).collect()
        }
        None if snapshot.pet.is_some() => app.sprite.lines(scale, app.theme),
        None => Vec::new(),
    };
    let (pet_width, pet_height) = match scene {
        Some(_) => (
            pet_lines
                .first()
                .map_or(0, |line| u16::try_from(line.width()).unwrap_or(u16::MAX)),
            u16::try_from(pet_lines.len()).unwrap_or(u16::MAX),
        ),
        None if snapshot.pet.is_some() => app.sprite.size(scale),
        None => (0, 0),
    };
    let left = area.x.saturating_add(1);
    if snapshot.pet.is_some() {
        let pet = Rect {
            x: left,
            y: area.y,
            width: pet_width.min(area.width.saturating_sub(1)),
            height: pet_height,
        };
        Paragraph::new(pet_lines).render(pet.intersection(area), buf);
    }
    let big = big || (scene.is_some() && pet_height >= 12);
    let gap = if snapshot.pet.is_some() {
        if big { 4 } else { 2 }
    } else {
        0
    };
    let facts_x = left.saturating_add(pet_width).saturating_add(gap);
    let facts_width = area.right().saturating_sub(facts_x).saturating_sub(1);
    let facts = facts(app, response, facts_width, big);
    let facts_height = u16::try_from(facts.len()).unwrap_or(u16::MAX);
    let facts_area = Rect {
        x: facts_x,
        y: area.y,
        width: facts_width,
        height: facts_height,
    };
    Paragraph::new(facts).render(facts_area.intersection(area), buf);

    let mut rows: Vec<Line> = vec![Line::raw("")];
    if let Some((grade, amount)) = app.feed.last_prompt() {
        rows.push(Line::from(vec![
            Span::raw("Last prompt · "),
            Span::styled(format!("{grade:.1}"), grade_style(app, grade)),
            Span::raw(" · "),
            Span::styled(format!("+{amount} XP"), paint(app, GOOD)),
        ]));
    }
    rows.push(Line::styled("Today", dim(app)));
    let today = today(app, snapshot);
    if today.is_empty() {
        rows.push(Line::styled(
            "Nothing yet today: a prompt, a commit or a merge shows here.",
            dim(app),
        ));
    }
    rows.extend(today);
    let top = area.y.saturating_add(pet_height.max(facts_height));
    let below = Rect {
        x: left,
        y: top,
        width: area.width.saturating_sub(2),
        height: area.bottom().saturating_sub(top),
    };
    Paragraph::new(rows).render(below.intersection(area), buf);
}

/// The body less a column each side, as every tab draws it.
fn inset(area: Rect) -> Rect {
    Rect {
        x: area.x.saturating_add(1),
        width: area.width.saturating_sub(2),
        ..area
    }
}

fn paint(app: &App, rgb: super::theme::Rgb) -> Style {
    Style::new().fg(app.theme.paint(rgb))
}

fn dim(app: &App) -> Style {
    paint(app, DIM)
}

fn grade_style(app: &App, grade: f64) -> Style {
    if grade >= 8.0 {
        paint(app, GOOD)
    } else if grade < 5.0 {
        paint(app, WARN)
    } else {
        Style::new()
    }
}

/// The facts beside the pet: who it is, the level, the streak, the sigil and the running mission. At 2× they are
/// spaced out along the pet's height, at 1× packed to fit its six rows.
fn facts(app: &App, response: &SnapshotResponse, width: u16, spaced: bool) -> Vec<Line<'static>> {
    let snapshot = &response.snapshot;
    let character = &snapshot.character;
    let mut lines = Vec::new();
    lines.push(match &snapshot.pet {
        Some(pet) => {
            let word = mood_word(pet.mood, response.rules.pet.happy_above);
            let filled = hearts(pet.mood);
            fit(
                vec![
                    vec![Span::raw(pet.name.to_string())],
                    vec![Span::raw(format!(" · form {}", pet.form))],
                    vec![Span::raw(format!(" · {word}"))],
                    vec![
                        Span::raw(" "),
                        Span::styled("♥".repeat(filled), paint(app, PINK)),
                        Span::styled("♡".repeat(5 - filled), dim(app)),
                    ],
                ],
                width,
            )
        }
        None => match &snapshot.egg {
            Some(egg) => Line::raw(format!(
                "{} is still an egg: it hatches in Claude Code",
                egg.name
            )),
            None => Line::raw("No pet yet"),
        },
    });
    if spaced {
        lines.push(Line::raw(""));
    }
    let level = format!("Lv {}", character.level);
    let numbers = format!(
        "{} / {}",
        count(character.xp.into_level),
        count(character.xp.for_next_level)
    );
    let room =
        usize::from(width).saturating_sub(level.chars().count() + numbers.chars().count() + 4);
    let cells = room.min(18);
    let filled = fill(character.xp.into_level, character.xp.for_next_level, cells);
    let mut level_line = vec![Span::styled(
        level,
        paint(app, ACCENT).add_modifier(Modifier::BOLD),
    )];
    if cells >= 4 {
        level_line.push(Span::raw("  "));
        level_line.push(Span::styled("█".repeat(filled), paint(app, GOOD)));
        level_line.push(Span::styled("░".repeat(cells - filled), paint(app, EMPTY)));
    }
    level_line.push(Span::raw("  "));
    level_line.push(Span::raw(numbers));
    lines.push(Line::from(level_line));
    let days = character.streak.days;
    let rest = character.streak.rest_days_left_this_week;
    lines.push(fit(
        vec![
            vec![Span::raw(format!(
                "Streak {days} {}",
                plural(days, "day", "days")
            ))],
            vec![Span::styled(
                format!(" · {rest} rest {} left", plural(rest, "day", "days")),
                dim(app),
            )],
        ],
        width,
    ));
    lines.push(sigil_line(app, snapshot));
    if spaced {
        lines.push(Line::raw(""));
    }
    lines.push(fit(running_parts(app, snapshot), width));
    lines
}

fn plural<'a>(n: u64, one: &'a str, many: &'a str) -> &'a str {
    if n == 1 { one } else { many }
}

/// How the pet feels in a word, as the mod says it (`care.ts` `moodWord`): happy above the rules' line, content above
/// half of it, sleepy below.
pub fn mood_word(mood: f64, happy_above: f64) -> &'static str {
    if mood > happy_above {
        "happy"
    } else if mood > happy_above / 2.0 {
        "content"
    } else {
        "sleepy"
    }
}

/// Filled hearts out of five for a mood of 0 to 100: one for every 20, and never none.
pub fn hearts(mood: f64) -> usize {
    ((mood / 20.0).round() as usize).clamp(1, 5)
}

/// How many of `cells` a bar fills for `part` of `whole`.
pub fn fill(part: u64, whole: u64, cells: usize) -> usize {
    if whole == 0 {
        return 0;
    }
    let share = (part.min(whole) as f64 / whole as f64) * cells as f64;
    (share.round() as usize).min(cells)
}

fn sigil_line(app: &App, snapshot: &Snapshot) -> Line<'static> {
    let worn = snapshot
        .character
        .equipped
        .get("sigil")
        .and_then(|entry_id| {
            let entry = snapshot
                .inventory
                .iter()
                .find(|entry| entry.id == *entry_id)?;
            let item = snapshot
                .items
                .iter()
                .find(|item| item.id == entry.item_id)?;
            Some((item, item.sigil.as_ref()?))
        });
    match worn {
        Some((item, sigil)) => {
            let colour = app
                .theme
                .hex(sigil.color.as_str())
                .unwrap_or_else(|| app.theme.rarity(item.rarity.as_str()));
            Line::from(vec![
                Span::raw("Sigil "),
                Span::styled(
                    format!("{} {}", sigil.glyph, multiplier(sigil.multiplier)),
                    Style::new().fg(colour),
                ),
                Span::styled(" worn", dim(app)),
            ])
        }
        None => Line::styled("No sigil worn", dim(app)),
    }
}

/// A multiplier as the mod writes it (`sigils.ts` `multiplierText`): `×2`, `×2.2`, `×1.25`.
pub fn multiplier(value: f64) -> String {
    let hundredths = (value * 100.0).round() / 100.0;
    let text = format!("{hundredths:.2}");
    let text = text.trim_end_matches('0').trim_end_matches('.');
    format!("×{text}")
}

/// The running missions, the nearest to done first, then the soonest to end, and one that never ends after those.
fn running(quests: &[Quest]) -> Vec<&Quest> {
    let mut quests: Vec<&Quest> = quests
        .iter()
        .filter(|quest| quest.status.as_str() == "active" && quest.progress < quest.goal)
        .collect();
    let share = |quest: &Quest| quest.progress as f64 / quest.goal.max(1) as f64;
    quests.sort_by(|a, b| {
        share(b).total_cmp(&share(a)).then_with(|| {
            let ends = |quest: &Quest| (quest.expires_at.is_none(), quest.expires_at.clone());
            ends(a).cmp(&ends(b))
        })
    });
    quests
}

/// The running mission, then when it ends and how many more run, each shown only if it fits.
fn running_parts(app: &App, snapshot: &Snapshot) -> Vec<Vec<Span<'static>>> {
    let quests = running(&snapshot.quests);
    let Some(quest) = quests.first() else {
        return vec![vec![Span::styled("No mission running", dim(app))]];
    };
    let mut parts = vec![vec![
        Span::raw("Running: "),
        Span::raw(format!("{} {}/{}", quest.title, quest.progress, quest.goal)),
    ]];
    let ends = quest
        .expires_at
        .as_ref()
        .and_then(|at| at.as_str().parse::<Timestamp>().ok());
    if let Some(ends) = ends {
        let seconds = ends.as_second().saturating_sub(app.now.as_second());
        parts.push(vec![Span::styled(
            format!(" · ends in {}", duration_words(seconds)),
            dim(app),
        )]);
    }
    if quests.len() > 1 {
        parts.push(vec![Span::styled(
            format!(" · {} more", quests.len() - 1),
            dim(app),
        )]);
    }
    parts
}

/// The tags' column, as wide as most tags are ("+125 XP", "✓ done").
const TAG_COLUMN: usize = 8;

/// Today's lines of the feed, newest first: what happened on the player's local date.
fn today(app: &App, snapshot: &Snapshot) -> Vec<Line<'static>> {
    let date = app.now.to_zoned(app.zone.clone()).date();
    let lines: Vec<_> = app
        .feed
        .newest()
        .filter(|line| line.at.to_zoned(app.zone.clone()).date() == date)
        .map(|line| (line.at, words(app, snapshot, &line.entry)))
        .collect();
    // The tags make a column as wide as the widest shown, so a big grant's "+25000 XP" pushes no line out of step.
    let column = lines
        .iter()
        .map(|(_, (tag, _, _))| tag.chars().count())
        .max()
        .unwrap_or(0)
        .max(TAG_COLUMN);
    lines
        .into_iter()
        .map(|(at, (tag, colour, text))| {
            let mut spans = vec![
                Span::styled(local_time(at, &app.zone), dim(app)),
                Span::raw("  "),
            ];
            spans.push(Span::styled(format!("{tag:<column$}"), colour));
            spans.push(Span::raw(" "));
            spans.extend(text);
            Line::from(spans)
        })
        .collect()
}

/// A feed entry as its tag, the tag's style, and the words after it.
fn words(app: &App, snapshot: &Snapshot, entry: &Entry) -> (String, Style, Vec<Span<'static>>) {
    match entry {
        Entry::Xp {
            amount,
            reason,
            grade,
        } => {
            let mut text = vec![Span::raw(feed::reason_words(reason).to_owned())];
            if let Some(grade) = grade {
                text.push(Span::raw(" "));
                text.push(Span::styled(
                    format!("{grade:.1}"),
                    grade_style(app, *grade),
                ));
            }
            (format!("+{amount} XP"), paint(app, GOOD), text)
        }
        Entry::Level { from, to, title } => {
            let climbed = if to.saturating_sub(*from) > 1 {
                format!("level up from {from}")
            } else {
                "level up".to_owned()
            };
            let text = match title {
                Some(title) => format!("{climbed} · {title}"),
                None => climbed,
            };
            (
                format!("Lv {to}"),
                paint(app, ACCENT).add_modifier(Modifier::BOLD),
                vec![Span::raw(text)],
            )
        }
        Entry::Loot { name, rarity } => {
            let style = Style::new().fg(app.theme.rarity(rarity));
            // The rarity is said after the name, as "legendary" is too long for the tag's column.
            (
                "◆ loot".to_owned(),
                style,
                vec![
                    Span::styled(name.clone(), style),
                    Span::raw(" dropped"),
                    Span::styled(format!(" · {rarity}"), dim(app)),
                ],
            )
        }
        Entry::Progress {
            quest_id,
            progress,
            goal,
        } => {
            let title = snapshot
                .quests
                .iter()
                .find(|quest| quest.quest_id.as_str() == quest_id)
                .map_or_else(|| quest_id.clone(), |quest| quest.title.to_string());
            (
                "▲".to_owned(),
                paint(app, ACCENT),
                vec![Span::raw(format!("{title} {progress}/{goal}"))],
            )
        }
        Entry::Done { title } => (
            "✓ done".to_owned(),
            paint(app, GOOD),
            vec![Span::raw(title.clone())],
        ),
        Entry::Badge { title } => (
            "✦ badge".to_owned(),
            paint(app, ACCENT),
            vec![Span::raw(title.clone())],
        ),
        Entry::Hatched { name } => (
            "♥ hatch".to_owned(),
            paint(app, PINK),
            vec![Span::raw(format!("{name} hatched"))],
        ),
        Entry::Gap => (
            "···".to_owned(),
            dim(app),
            vec![Span::styled("the stream started over", dim(app))],
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::Text;

    #[test]
    fn words_a_mood_as_the_mod_does() {
        assert_eq!(mood_word(100.0, 70.0), "happy");
        assert_eq!(mood_word(70.0, 70.0), "content");
        assert_eq!(mood_word(35.0, 70.0), "sleepy");
        assert_eq!((hearts(100.0), hearts(0.0), hearts(49.0)), (5, 1, 2));
    }

    #[test]
    fn writes_a_multiplier_as_the_mod_does() {
        assert_eq!(multiplier(2.0), "×2");
        assert_eq!(multiplier(2.2), "×2.2");
        assert_eq!(multiplier(1.25), "×1.25");
    }

    fn quest(id: &str, progress: u64, expires_at: Option<&str>) -> Quest {
        Quest {
            quest_id: Text::new(id),
            title: Text::new(id),
            status: Text::new("active"),
            progress,
            goal: 4,
            expires_at: expires_at.map(Text::new),
        }
    }

    #[test]
    fn runs_a_mission_that_never_ends_after_those_that_end_soonest() {
        let quests = [
            quest("forever", 2, None),
            quest("later", 2, Some("2026-10-12T00:00:00.000Z")),
            quest("sooner", 2, Some("2026-10-09T23:59:59.999Z")),
            quest("nearer", 3, None),
        ];
        let order: Vec<&str> = running(&quests)
            .iter()
            .map(|quest| quest.quest_id.as_str())
            .collect();
        assert_eq!(order, ["nearer", "sooner", "later", "forever"]);
    }

    #[test]
    fn fills_a_bar_by_share() {
        assert_eq!(fill(113, 1514, 18), 1);
        assert_eq!(fill(1514, 1514, 18), 18);
        assert_eq!(fill(5, 0, 18), 0);
        assert_eq!(fill(99, 10, 4), 4);
    }
}
