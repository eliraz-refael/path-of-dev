import { Schema } from "effect"

// Shared scalars of the wire format: ids are ULIDs, times are ISO 8601 strings, money-like numbers are integers.

export const Ulid = Schema.String.pipe(Schema.check(Schema.isULID()))

export const IsoDateTime = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/u)),
)

export const IsoDate = Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u)))

/** `owner/name` of a GitHub repo, in GitHub's character set so a local path can't pass for one. */
export const GitHubRepo = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/u)),
)

/** SHA-1, or SHA-256 in repos created with `--object-format=sha256`. */
export const GitSha = Schema.String.pipe(Schema.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u)))

export const Count = Schema.Natural

/** How many of something a mission or an achievement asks for: at least one. */
export const Goal = Count.pipe(Schema.check(Schema.isGreaterThan(0)))

/** A grade or a quality score, 0-10. */
export const Score = Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 10 })))

/** A factor on XP: 1 changes nothing, and nothing in the game lowers XP. */
export const Multiplier = Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1)))

export const Probability = Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 })))

/** A share of something in percent, 0-100: how full the context is. */
export const Percent = Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100 })))

/**
 * What stands before "Lv" in the band: a glyph one cell wide (`⚔`) or, as an emoji, two (`👑`, or `🛡️` with its
 * emoji selector), so the mod can keep it in a two-cell slot.
 */
export const Glyph = Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(8)))

/** A color as `#rrggbb`. */
export const HexColor = Schema.String.pipe(Schema.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/u)))

/** A character or pet name. */
export const Name = Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(32)))

/**
 * A name as the player typed it, before the engine tidies and checks it: the engine refuses one it can't keep, in
 * words the player reads, rather than the request failing on its shape.
 */
export const TypedName = Schema.String.pipe(Schema.check(Schema.isMaxLength(200)))

// Code units jsonb can't hold: a NUL, or half of a surrogate pair with no other half. Postgres and PGlite refuse
// both, so an input holding one would fail its write with a 500.
const unstorable = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

/** Whether every string in `value`, keys too, can be kept in a jsonb column. */
export const isStorable = (value: unknown): boolean =>
  typeof value === "string"
    ? !unstorable.test(value)
    : Array.isArray(value)
      ? value.every(isStorable)
      : typeof value === "object" && value !== null
        ? Object.entries(value).every(([key, field]) => isStorable(key) && isStorable(field))
        : true

/** For an input the server logs as jsonb: one it couldn't keep is malformed, not a failed write. */
export const storable = Schema.makeFilter((value: unknown) => isStorable(value) || "no NUL and no lone surrogate")

// Enums the mod reads are open on the wire: a newer server may send a value an older mod doesn't know, and the
// mod renders it with a fallback. The schemas stay closed because the server validates what it accepts.

export const Rarity = Schema.Literals(["common", "uncommon", "rare", "epic", "legendary"])
export type Rarity = typeof Rarity.Type

export const PetSlot = Schema.Literals(["head", "neck", "back", "hand", "aura"])
export type PetSlot = typeof PetSlot.Type

/** The band's own slots: each holds a band style, a look the mod draws from data alone. */
export const BandSlot = Schema.Literals(["xpBar", "levelDisplay", "topEdge", "goldDisplay"])
export type BandSlot = typeof BandSlot.Type

/** The character's slots: a level-up effect, a scene, the band's own, and the one sigil, which multiplies prompt XP. */
export const CharacterSlot = Schema.Literals(["levelUpEffect", "scene", ...BandSlot.literals, "sigil"])
export type CharacterSlot = typeof CharacterSlot.Type

export const Slot = Schema.Union([PetSlot, CharacterSlot])
export type Slot = typeof Slot.Type

/** What an item is, which decides where it goes: a pet's gear, a band style, food to eat, and so on. */
export const ItemCategory = Schema.Literals([
  "food",
  "wearable",
  "scene",
  "title",
  "artefact",
  "levelUpEffect",
  "bandStyle",
  "sigil",
])
export type ItemCategory = typeof ItemCategory.Type

export const XpTier = Schema.Literals(["verified", "reported"])
export type XpTier = typeof XpTier.Type

/** Rubric 1's scores that make a prompt's quality, and so its XP, each 0-10 against what the prompt needs. */
export const QualityDimension = Schema.Literals([
  "clarity",
  "grammar",
  "specificity",
  "instructive",
  "context",
  "doneCriteria",
  "focus",
])
export type QualityDimension = typeof QualityDimension.Type

/** Everything rubric 1 scores: the quality, plus `regret`, which only the player stats count. */
export const GradeDimension = Schema.Literals([...QualityDimension.literals, "regret"])
export type GradeDimension = typeof GradeDimension.Type

/**
 * Rubric 2's content measures, each 0-10 against what the prompt needs at that point in the conversation; `why` and
 * `successShape` are null when it doesn't need them.
 */
export const ContentMeasure = Schema.Literals(["intent", "grounding", "why", "successShape", "scope", "forward"])
export type ContentMeasure = typeof ContentMeasure.Type

/** Everything rubric 2 scores: the content, plus `craft` (the writing) and `tone`, which only nudge the grade. */
export const Measure = Schema.Literals([...ContentMeasure.literals, "craft", "tone"])
export type Measure = typeof Measure.Type

/** What a prompt is, as rubric 2 reads it: a steer is a short reply to the assistant's last message. */
export const PromptKind = Schema.Literals(["task", "question", "discussion", "steer"])
export type PromptKind = typeof PromptKind.Type
