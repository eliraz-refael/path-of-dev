//! The server's answers, as the companion reads them: only the fields it draws, held to the TypeScript's own answers
//! by `tests/contract.rs`, which lists every field skipped here in `contract/unread.txt`.
//!
//! The types are lenient at run time: no `deny_unknown_fields`, and an event type this build doesn't know decodes as
//! `EventBody::Other`, which draws nothing, so a newer server still works. Every string is a `Text`, cleaned of control
//! characters as it is decoded, because ratatui draws a span's bytes as they are, escapes included.

use std::collections::BTreeMap;
use std::fmt;

use serde::de::{self, DeserializeSeed, IgnoredAny, MapAccess, Visitor};
use serde::{Deserialize, Deserializer};

/// A string from the server, with every control character (C0, DEL and C1, so ESC too) taken out.
#[derive(Clone, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct Text(String);

impl Text {
    pub fn new(raw: &str) -> Self {
        Text(raw.chars().filter(|c| !is_control(*c)).collect())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// C0 (below a space), DEL, and C1 (U+0080 to U+009F): what a terminal may read as the start of a command.
pub fn is_control(c: char) -> bool {
    c < ' ' || ('\u{7f}'..='\u{9f}').contains(&c)
}

impl fmt::Debug for Text {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&self.0, f)
    }
}

impl fmt::Display for Text {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for Text {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Ok(Text::new(&raw))
    }
}

// ── GET /v1/snapshot ─────────────────────────────────────────────────────────────────────────────────────────────────

/// `GET /v1/snapshot`: the player's state, the rules it was made under, and the oldest mod the server still serves.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotResponse {
    pub snapshot: Snapshot,
    pub rules: Rules,
    pub min_client_version: Text,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// Which stream the cursor counts in: another id means another player or server.
    pub server_id: Text,
    pub stream_epoch: u64,
    pub character: Character,
    pub pet: Option<Pet>,
    pub egg: Option<Egg>,
    pub inventory: Vec<InventoryEntry>,
    /// The definitions of what the inventory holds, the shop offers and the shards can craft.
    pub items: Vec<ItemDef>,
    pub quests: Vec<Quest>,
    /// The last stream event this state includes.
    pub cursor: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Character {
    pub name: Text,
    pub level: u64,
    pub xp: Xp,
    pub title: Text,
    pub gold: u64,
    pub streak: Streak,
    /// Slot to inventory entry id.
    pub equipped: BTreeMap<String, Text>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp {
    pub into_level: u64,
    pub for_next_level: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Streak {
    pub days: u64,
    pub rest_days_left_this_week: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pet {
    pub name: Text,
    /// The evolution stage, 0 to 3.
    pub form: u64,
    /// 0 to 100.
    pub mood: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Egg {
    pub name: Text,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryEntry {
    pub id: Text,
    pub item_id: Text,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemDef {
    pub id: Text,
    pub name: Text,
    pub rarity: Text,
    /// The art it is drawn with, by id: a scene's in `assets/scenes.json`.
    pub sprite: Option<Text>,
    /// Sigils only.
    pub sigil: Option<SigilPower>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SigilPower {
    pub multiplier: f64,
    pub glyph: Text,
    /// `#rrggbb`.
    pub color: Text,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quest {
    pub quest_id: Text,
    pub title: Text,
    pub status: Text,
    pub progress: u64,
    pub goal: u64,
    pub expires_at: Option<Text>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rules {
    pub version: u64,
    pub pet: PetRules,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetRules {
    /// A pet whose mood is above this is happy.
    pub happy_above: f64,
}

// ── GET /v1/stream ───────────────────────────────────────────────────────────────────────────────────────────────────

/// `GET /v1/stream?after=<cursor>`: the events after the cursor, answered at once or after 25 seconds with none.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamResponse {
    pub events: Vec<Event>,
    pub cursor: u64,
    /// The cursor is too old, ahead of this stream, or from another stream: read the snapshot again.
    pub resync: Option<bool>,
    pub rules_version: u64,
    pub min_client_version: Text,
}

/// A server event: its place in the stream, when it happened, what caused it, and what it says.
#[derive(Debug, Clone)]
pub struct Event {
    pub seq: u64,
    /// An ISO date-time.
    pub at: Text,
    /// The command or client event that led to it: events sharing a cause play as one moment.
    pub cause: Option<Text>,
    pub body: EventBody,
}

/// What an event says, for the types the companion draws; any other type is `Other`.
#[derive(Debug, Clone)]
pub enum EventBody {
    XpGranted(XpGranted),
    LevelUp(LevelUp),
    LootDropped(LootDropped),
    QuestProgress(QuestProgress),
    QuestCompleted(QuestCompleted),
    AchievementUnlocked(AchievementUnlocked),
    PetHatched(PetHatched),
    Other,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XpGranted {
    pub amount: u64,
    /// The scoring fact (`prompt.graded`, `commit.made`, …), `quest` for a mission's reward, or `dev`.
    pub reason: Text,
    /// A graded prompt's weighted grade, 0 to 10.
    pub grade: Option<f64>,
    /// The multiplier of the sigil worn when it was priced.
    pub sigil: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelUp {
    pub from: u64,
    pub to: u64,
    pub title: Option<Text>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LootDropped {
    pub item: DroppedItem,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DroppedItem {
    pub name: Text,
    pub rarity: Text,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestProgress {
    pub quest_id: Text,
    pub progress: u64,
    pub goal: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestCompleted {
    pub title: Text,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementUnlocked {
    pub title: Text,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetHatched {
    pub name: Text,
}

// An event is `{ type, data, seq, at, cause }`, and which shape `data` has depends on `type`. serde's tagged enums would
// read it, but they buffer the whole event first, which hides every field they skip from the contract test's
// `serde_ignored`. So the event is read by hand: `data` is decoded in place once `type` is known, as the server writes
// `type` first, and only buffered when it comes first.

impl<'de> Deserialize<'de> for Event {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_map(EventVisitor)
    }
}

struct EventVisitor;

impl<'de> Visitor<'de> for EventVisitor {
    type Value = Event;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a server event")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Event, A::Error> {
        let mut kind: Option<String> = None;
        let mut body: Option<EventBody> = None;
        let mut early: Option<serde_json::Value> = None;
        let mut seq: Option<u64> = None;
        let mut at: Option<Text> = None;
        let mut cause: Option<Option<Text>> = None;
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "type" => kind = Some(map.next_value()?),
                "data" => match &kind {
                    Some(kind) => body = Some(map.next_value_seed(BodySeed(kind))?),
                    None => early = Some(map.next_value()?),
                },
                "seq" => seq = Some(map.next_value()?),
                "at" => at = Some(map.next_value()?),
                "cause" => cause = Some(map.next_value()?),
                _ => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        let kind = kind.ok_or_else(|| de::Error::missing_field("type"))?;
        let body = match (body, early) {
            (Some(body), _) => body,
            (None, Some(data)) => BodySeed(&kind)
                .deserialize(data)
                .map_err(de::Error::custom)?,
            (None, None) => return Err(de::Error::missing_field("data")),
        };
        Ok(Event {
            seq: seq.ok_or_else(|| de::Error::missing_field("seq"))?,
            at: at.ok_or_else(|| de::Error::missing_field("at"))?,
            cause: cause.ok_or_else(|| de::Error::missing_field("cause"))?,
            body,
        })
    }
}

/// Decodes an event's `data` as its `type` says.
struct BodySeed<'a>(&'a str);

impl<'de> DeserializeSeed<'de> for BodySeed<'_> {
    type Value = EventBody;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<EventBody, D::Error> {
        Ok(match self.0 {
            "xp.granted" => EventBody::XpGranted(Deserialize::deserialize(deserializer)?),
            "level.up" => EventBody::LevelUp(Deserialize::deserialize(deserializer)?),
            "loot.dropped" => EventBody::LootDropped(Deserialize::deserialize(deserializer)?),
            "quest.progress" => EventBody::QuestProgress(Deserialize::deserialize(deserializer)?),
            "quest.completed" => EventBody::QuestCompleted(Deserialize::deserialize(deserializer)?),
            "achievement.unlocked" => {
                EventBody::AchievementUnlocked(Deserialize::deserialize(deserializer)?)
            }
            "pet.hatched" => EventBody::PetHatched(Deserialize::deserialize(deserializer)?),
            _ => {
                IgnoredAny::deserialize(deserializer)?;
                EventBody::Other
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_drops_control_characters() {
        let text: Text = serde_json::from_str(r#""a\u001b[31mb\u0007c\u009bd\u007fe""#).unwrap();
        assert_eq!(text.as_str(), "a[31mbcde");
    }

    #[test]
    fn an_event_of_a_newer_type_draws_nothing() {
        let event: Event =
            serde_json::from_str(r#"{"type":"pet.danced","data":{"steps":3},"seq":4,"at":"2026-10-09T08:00:00.000Z","cause":null}"#)
                .unwrap();
        assert!(matches!(event.body, EventBody::Other));
        assert_eq!(event.seq, 4);
    }

    #[test]
    fn an_event_whose_data_comes_before_its_type_still_reads() {
        let event: Event = serde_json::from_str(
            r#"{"data":{"amount":12,"reason":"prompt.graded","grade":8.2},"type":"xp.granted","seq":1,"at":"x","cause":"c"}"#,
        )
        .unwrap();
        let EventBody::XpGranted(granted) = event.body else {
            panic!("not xp.granted")
        };
        assert_eq!((granted.amount, granted.grade), (12, Some(8.2)));
    }

    #[test]
    fn an_event_without_its_seq_is_refused() {
        let decoded =
            serde_json::from_str::<Event>(r#"{"type":"notice","data":{},"at":"x","cause":null}"#);
        assert!(decoded.is_err());
    }
}
