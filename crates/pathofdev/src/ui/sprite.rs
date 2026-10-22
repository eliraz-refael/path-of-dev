//! The pet, from `assets/sprite.json`, which the mod's contract test writes from the schema's `petSprite`, in half
//! blocks: each cell holds two pixels, the top one as the foreground of `▀` and the bottom one as its background, an
//! empty top as `▄`, both empty as a space. At 2× each pixel is two wide and two tall, so 14×12 pixels take 28×12
//! cells; at 1× they take 14×6.

use std::collections::BTreeMap;

use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use serde::Deserialize;

use super::theme::Theme;

/// The sprite as the schema has it: rows of letters, `.` for no pixel, and each letter's `#rrggbb`.
#[derive(Debug, Clone, Deserialize)]
pub struct Sprite {
    pub rows: Vec<String>,
    pub palette: BTreeMap<String, String>,
}

impl Sprite {
    /// The pet the binary carries.
    pub fn embedded() -> Result<Sprite, serde_json::Error> {
        serde_json::from_str(include_str!("../../assets/sprite.json"))
    }

    /// Its size in cells at `scale`: (columns, rows).
    pub fn size(&self, scale: usize) -> (u16, u16) {
        let width = self
            .rows
            .iter()
            .map(|row| row.chars().count())
            .max()
            .unwrap_or(0)
            * scale;
        let height = (self.rows.len() * scale).div_ceil(2);
        (
            u16::try_from(width).unwrap_or(u16::MAX),
            u16::try_from(height).unwrap_or(u16::MAX),
        )
    }

    /// The pixels at `scale`, each painted from the palette, or None where there is none.
    fn pixels(&self, scale: usize, theme: Theme) -> Vec<Vec<Option<Color>>> {
        self.rows
            .iter()
            .flat_map(|row| {
                let cells: Vec<Option<Color>> = row
                    .chars()
                    .flat_map(|letter| {
                        let colour = self
                            .palette
                            .get(letter.encode_utf8(&mut [0; 4]) as &str)
                            .and_then(|hex| theme.hex(hex));
                        std::iter::repeat_n(colour, scale)
                    })
                    .collect();
                std::iter::repeat_n(cells, scale)
            })
            .collect()
    }

    /// The lines that draw it at `scale`.
    pub fn lines(&self, scale: usize, theme: Theme) -> Vec<Line<'static>> {
        let pixels = self.pixels(scale, theme);
        pixels
            .chunks(2)
            .map(|pair| {
                let top = &pair[0];
                let bottom = pair.get(1);
                let spans: Vec<Span<'static>> = top
                    .iter()
                    .enumerate()
                    .map(|(x, top)| {
                        let bottom = bottom.and_then(|row| row.get(x).copied().flatten());
                        match (*top, bottom) {
                            (None, None) => Span::raw(" "),
                            (Some(top), None) => Span::styled("▀", Style::new().fg(top)),
                            (None, Some(bottom)) => Span::styled("▄", Style::new().fg(bottom)),
                            (Some(top), Some(bottom)) => {
                                Span::styled("▀", Style::new().fg(top).bg(bottom))
                            }
                        }
                    })
                    .collect();
                Line::from(spans)
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_embedded_sprite_reads_and_every_letter_has_a_colour() {
        let sprite = Sprite::embedded().unwrap();
        let width = sprite.rows[0].chars().count();
        assert!(sprite.rows.iter().all(|row| row.chars().count() == width));
        for letter in sprite
            .rows
            .iter()
            .flat_map(|row| row.chars())
            .filter(|c| *c != '.')
        {
            let hex = sprite.palette.get(&letter.to_string()).unwrap();
            assert!(
                Theme { truecolor: true }.hex(hex).is_some(),
                "{letter} is {hex}"
            );
        }
        assert_eq!(sprite.size(2), (28, 12));
        assert_eq!(sprite.size(1), (14, 6));
    }

    #[test]
    fn draws_two_pixels_a_cell() {
        let sprite = Sprite {
            rows: vec!["ab.".into(), "a..".into()],
            palette: [
                ("a".into(), "#ff0000".into()),
                ("b".into(), "#00ff00".into()),
            ]
            .into(),
        };
        let lines = sprite.lines(1, Theme { truecolor: true });
        assert_eq!(lines.len(), 1);
        let cells: Vec<(String, Style)> = lines[0]
            .spans
            .iter()
            .map(|span| (span.content.to_string(), span.style))
            .collect();
        assert_eq!(
            cells,
            [
                (
                    "▀".into(),
                    Style::new()
                        .fg(Color::Rgb(255, 0, 0))
                        .bg(Color::Rgb(255, 0, 0))
                ),
                ("▀".into(), Style::new().fg(Color::Rgb(0, 255, 0))),
                (" ".into(), Style::new()),
            ]
        );
        assert_eq!(sprite.lines(2, Theme { truecolor: true }).len(), 2);
    }
}
