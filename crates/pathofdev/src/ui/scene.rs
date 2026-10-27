//! Scenes, from `assets/scenes.json`, which the mod's contract test writes from the engine's `starterSceneArt`: the
//! backdrop the pet stands in on the Home tab, in half blocks like the pet (`sprite.rs`), every cell filled. A scene is
//! 48×24 pixels, 48×12 cells, the pet standing at `pet` on it; a pane too narrow for all of it keeps the part round
//! the pet. A legendary scene loops: each frame lays a few cells over it, never near the pet, at its own rate.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use jiff::Timestamp;
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use serde::Deserialize;

use super::sprite::Sprite;
use super::theme::Theme;
use crate::wire::Snapshot;

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Size {
    pub width: usize,
    pub height: usize,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct At {
    pub x: usize,
    pub y: usize,
}

/// One scene's art: rows of letters, each letter's `#rrggbb`, and for a loop its frames (`.` keeps the scene's cell)
/// and how many a second.
#[derive(Debug, Clone, Deserialize)]
pub struct SceneArt {
    pub rows: Vec<String>,
    pub palette: BTreeMap<String, String>,
    #[serde(default)]
    pub frames: Option<Vec<Vec<String>>>,
    #[serde(default)]
    pub fps: Option<u32>,
}

/// Every scene the binary carries, by its sprite id, with their size and where the pet stands.
#[derive(Debug, Clone, Deserialize)]
pub struct Scenes {
    pub size: Size,
    pub pet: At,
    pub scenes: BTreeMap<String, SceneArt>,
}

impl Scenes {
    /// The scenes the binary carries; none, should they fail to read, so the pet still draws on its own.
    pub fn embedded() -> &'static Scenes {
        static SCENES: OnceLock<Scenes> = OnceLock::new();
        SCENES.get_or_init(|| {
            serde_json::from_str(include_str!("../../assets/scenes.json")).unwrap_or(Scenes {
                size: Size {
                    width: 48,
                    height: 24,
                },
                pet: At { x: 17, y: 11 },
                scenes: BTreeMap::new(),
            })
        })
    }

    /// The art of the scene the player wears: the `scene` slot's entry, its item, and the art its sprite names.
    pub fn worn(&self, snapshot: &Snapshot) -> Option<&SceneArt> {
        let entry = snapshot.character.equipped.get("scene")?;
        let owned = snapshot.inventory.iter().find(|one| one.id == *entry)?;
        let item = snapshot.items.iter().find(|def| def.id == owned.item_id)?;
        self.scenes.get(item.sprite.as_ref()?.as_str())
    }

    /// Its size in cells: (columns, rows).
    pub fn cells(&self) -> (u16, u16) {
        (
            u16::try_from(self.size.width).unwrap_or(u16::MAX),
            u16::try_from(self.size.height.div_ceil(2)).unwrap_or(u16::MAX),
        )
    }

    /// The lines that draw `art` at `now` with `pet` standing on it, `width` cells of it at most: all of it, or the
    /// part round the pet.
    pub fn lines(
        &self,
        art: &SceneArt,
        pet: &Sprite,
        now: Timestamp,
        width: u16,
        theme: Theme,
    ) -> Vec<Line<'static>> {
        let mut pixels = art.pixels_at(art.frame_at(now), theme);
        for (dy, row) in pet.rows.iter().enumerate() {
            for (dx, letter) in row.chars().enumerate() {
                let colour = pet
                    .palette
                    .get(letter.encode_utf8(&mut [0; 4]) as &str)
                    .and_then(|hex| theme.hex(hex));
                let cell = pixels
                    .get_mut(self.pet.y + dy)
                    .and_then(|line| line.get_mut(self.pet.x + dx));
                if let (Some(colour), Some(cell)) = (colour, cell) {
                    *cell = colour;
                }
            }
        }
        let shown = usize::from(width).clamp(1, self.size.width);
        let pet_width = pet.rows.first().map_or(0, |row| row.chars().count());
        let middle = self.pet.x + pet_width / 2;
        let left = middle
            .saturating_sub(shown / 2)
            .min(self.size.width - shown);
        pixels
            .chunks(2)
            .map(|pair| {
                let top = &pair[0];
                let bottom = pair.get(1).unwrap_or(top);
                let spans: Vec<Span<'static>> = (left..left + shown)
                    .map(|x| {
                        let fg = top.get(x).copied().unwrap_or(Color::Reset);
                        let bg = bottom.get(x).copied().unwrap_or(fg);
                        Span::styled("▀", Style::new().fg(fg).bg(bg))
                    })
                    .collect();
                Line::from(spans)
            })
            .collect()
    }
}

impl SceneArt {
    /// Whether it loops: two frames or more, at a rate.
    pub fn loops(&self) -> bool {
        self.frames.as_ref().is_some_and(|frames| frames.len() > 1) && self.fps.unwrap_or(0) > 0
    }

    /// How long a frame shows: what the screen waits at most between draws while this scene is on it.
    pub fn frame_ms(&self) -> Option<u64> {
        if self.loops() {
            Some(1000 / u64::from(self.fps?.max(1)))
        } else {
            None
        }
    }

    /// The frame it shows at `now`, on a clock of its own rate; None when it is still.
    pub fn frame_at(&self, now: Timestamp) -> Option<usize> {
        let count = i64::try_from(self.frames.as_ref()?.len()).ok()?;
        let ms = i64::try_from(self.frame_ms()?).ok()?;
        usize::try_from(now.as_millisecond().div_euclid(ms).rem_euclid(count)).ok()
    }

    /// The colours of its cells, frame `frame` laid over it when it is given.
    fn pixels_at(&self, frame: Option<usize>, theme: Theme) -> Vec<Vec<Color>> {
        let over = frame.and_then(|i| self.frames.as_ref()?.get(i));
        self.rows
            .iter()
            .enumerate()
            .map(|(y, row)| {
                let laid: Vec<char> = over
                    .and_then(|frame| frame.get(y))
                    .map(|line| line.chars().collect())
                    .unwrap_or_default();
                row.chars()
                    .enumerate()
                    .map(|(x, letter)| {
                        let letter = match laid.get(x) {
                            Some(&cell) if cell != '.' => cell,
                            _ => letter,
                        };
                        self.palette
                            .get(letter.encode_utf8(&mut [0; 4]) as &str)
                            .and_then(|hex| theme.hex(hex))
                            .unwrap_or(Color::Reset)
                    })
                    .collect()
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_scene_reads_whole_and_every_letter_has_a_colour() {
        let scenes = Scenes::embedded();
        assert_eq!(scenes.scenes.len(), 72);
        assert_eq!(scenes.cells(), (48, 12));
        for (id, art) in &scenes.scenes {
            assert_eq!(art.rows.len(), scenes.size.height, "{id}");
            for row in &art.rows {
                assert_eq!(row.chars().count(), scenes.size.width, "{id}");
                for letter in row.chars() {
                    let hex = art.palette.get(&letter.to_string()).unwrap();
                    assert!(Theme { truecolor: true }.hex(hex).is_some(), "{id}: {hex}");
                }
            }
        }
    }

    #[test]
    fn draws_every_scene_at_any_width_in_truecolor_and_in_256_colours() {
        let scenes = Scenes::embedded();
        let pet = Sprite::embedded().unwrap();
        for truecolor in [true, false] {
            let theme = Theme { truecolor };
            for (id, art) in &scenes.scenes {
                for width in [1, 14, 30, 48, 120] {
                    let lines = scenes.lines(art, &pet, Timestamp::UNIX_EPOCH, width, theme);
                    assert_eq!(lines.len(), 12, "{id}");
                    for line in &lines {
                        assert_eq!(line.spans.len(), usize::from(width.min(48)), "{id}");
                        for span in &line.spans {
                            let painted = |colour: Option<Color>| match colour {
                                Some(Color::Rgb(..)) => truecolor,
                                Some(Color::Indexed(_)) => !truecolor,
                                _ => false,
                            };
                            assert!(painted(span.style.fg) && painted(span.style.bg), "{id}");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn stands_the_pet_where_the_scene_puts_it_and_keeps_it_in_a_narrow_pane() {
        let scenes = Scenes::embedded();
        let pet = Sprite::embedded().unwrap();
        let art = &scenes.scenes["clear-night"];
        let theme = Theme { truecolor: true };
        let outline = theme.hex(&pet.palette["o"]);
        let whole = scenes.lines(art, &pet, Timestamp::UNIX_EPOCH, 48, theme);
        // The ear's tip, on the pet's first row (11): the lower half of a cell, its background.
        let row = scenes.pet.y / 2;
        let half = |span: &Span| {
            if scenes.pet.y.is_multiple_of(2) {
                span.style.fg
            } else {
                span.style.bg
            }
        };
        assert_eq!(half(&whole[row].spans[scenes.pet.x + 2]), outline);
        let narrow = scenes.lines(art, &pet, Timestamp::UNIX_EPOCH, 20, theme);
        let left = scenes.pet.x + 7 - 10;
        assert_eq!(half(&narrow[row].spans[scenes.pet.x + 2 - left]), outline);
    }

    #[test]
    fn a_legendary_scene_moves_on_its_own_clock_and_a_still_one_never_does() {
        let scenes = Scenes::embedded();
        let looping: Vec<_> = scenes.scenes.values().filter(|art| art.loops()).collect();
        assert_eq!(looping.len(), 4);
        for art in looping {
            let ms = art.frame_ms().unwrap();
            let at = |n: i64| Timestamp::from_millisecond(n * i64::try_from(ms).unwrap()).unwrap();
            assert_eq!(art.frame_at(at(0)), Some(0));
            assert_eq!(art.frame_at(at(1)), Some(1));
        }
        let still = &scenes.scenes["clear-night"];
        assert_eq!(still.frame_at(Timestamp::UNIX_EPOCH), None);
        assert_eq!(still.frame_ms(), None);
    }
}
