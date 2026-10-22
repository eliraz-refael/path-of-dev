//! The companion's colours, as the mockup has them, in truecolor or the nearest of xterm's 256 when the terminal
//! doesn't say it draws 24-bit colour (`COLORTERM`).

use ratatui::style::Color;

/// The lilac of the pet: the level, the selected tab, the companion's own accent.
pub const ACCENT: Rgb = Rgb(0xb6, 0xa6, 0xff);
/// The XP bar's fill, a live link, a good grade.
pub const GOOD: Rgb = Rgb(0x7e, 0xe0, 0xa1);
/// A poor grade, and every warning.
pub const WARN: Rgb = Rgb(0xff, 0xb8, 0x6b);
/// Hearts, and epic loot.
pub const PINK: Rgb = Rgb(0xff, 0x8f, 0xb1);
pub const RARE: Rgb = Rgb(0x7f, 0xb8, 0xff);
pub const DIM: Rgb = Rgb(0x7c, 0x73, 0x95);
/// The empty part of a bar.
pub const EMPTY: Rgb = Rgb(0x3d, 0x35, 0x54);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rgb(pub u8, pub u8, pub u8);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Theme {
    pub truecolor: bool,
}

impl Theme {
    /// The theme for a terminal whose `COLORTERM` is `colorterm`.
    pub fn for_colorterm(colorterm: Option<&str>) -> Self {
        Theme {
            truecolor: matches!(colorterm, Some("truecolor" | "24bit")),
        }
    }

    pub fn paint(self, rgb: Rgb) -> Color {
        let Rgb(r, g, b) = rgb;
        if self.truecolor {
            Color::Rgb(r, g, b)
        } else {
            Color::Indexed(xterm_256(r, g, b))
        }
    }

    /// A `#rrggbb` from the server or the sprite, painted; None when it isn't one.
    pub fn hex(self, hex: &str) -> Option<Color> {
        let digits = hex.strip_prefix('#')?;
        if digits.len() != 6 {
            return None;
        }
        let value = u32::from_str_radix(digits, 16).ok()?;
        let [_, r, g, b] = value.to_be_bytes();
        Some(self.paint(Rgb(r, g, b)))
    }

    /// The colour of a rarity's name.
    pub fn rarity(self, rarity: &str) -> Color {
        self.paint(match rarity {
            "uncommon" => GOOD,
            "rare" => RARE,
            "epic" => PINK,
            "legendary" => WARN,
            _ => DIM,
        })
    }
}

/// The nearest colour of xterm's 256: the 6×6×6 cube or the 24 greys, whichever is closer.
pub fn xterm_256(r: u8, g: u8, b: u8) -> u8 {
    const LEVELS: [u8; 6] = [0, 95, 135, 175, 215, 255];
    let level = |c: u8| -> usize {
        LEVELS
            .iter()
            .enumerate()
            .min_by_key(|(_, l)| (i32::from(**l) - i32::from(c)).abs())
            .map_or(0, |(i, _)| i)
    };
    let (ri, gi, bi) = (level(r), level(g), level(b));
    let cube = (LEVELS[ri], LEVELS[gi], LEVELS[bi]);
    let mean = (u32::from(r) + u32::from(g) + u32::from(b)) / 3;
    let grey_index = (mean.saturating_sub(3) / 10).min(23) as u8;
    let grey = 8 + 10 * grey_index;
    let distance = |(x, y, z): (u8, u8, u8)| {
        let d = |a: u8, b: u8| (i32::from(a) - i32::from(b)).pow(2);
        d(x, r) + d(y, g) + d(z, b)
    };
    if distance((grey, grey, grey)) < distance(cube) {
        232 + grey_index
    } else {
        16 + 36 * ri as u8 + 6 * gi as u8 + bi as u8
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paints_in_truecolor_only_when_the_terminal_says_so() {
        assert_eq!(
            Theme::for_colorterm(Some("truecolor")).hex("#2a1f4a"),
            Some(Color::Rgb(42, 31, 74))
        );
        assert_eq!(
            Theme::for_colorterm(None).hex("#ffffff"),
            Some(Color::Indexed(231))
        );
        assert_eq!(
            Theme::for_colorterm(None).hex("#000000"),
            Some(Color::Indexed(16))
        );
        assert_eq!(
            Theme::for_colorterm(None).hex("#808080"),
            Some(Color::Indexed(244))
        );
        assert_eq!(Theme::for_colorterm(None).hex("red"), None);
    }
}
