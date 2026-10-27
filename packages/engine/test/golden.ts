import { readFileSync } from "node:fs"
import type { Context, InventoryEntry, PlayerState } from "@pathofdev/schema"
import { CommandRefusal, Input, IsoDateTime, QuestPack, RollRecord } from "@pathofdev/schema"
import { Schema } from "effect"
import { catalog6, initialState, rules14, starterQuestPack } from "../src/index.ts"

// The golden v1 log's player and the context each of its steps ran under. The log itself is in fixtures/v1-log.json,
// written once by main's engine 14 (fixtures/write-v1-log.ts), so a later engine can be held to what that one did with
// the same inputs: a v1 prompt must earn just what it earned then.

export const goldenSeed = "golden-v1-seed-37"
export const goldenZone = "America/New_York"
/** A Friday, 08:00 in New York: the log runs ten local days from it, over two local weeks. */
export const goldenStart = "2026-10-09T12:00:00Z"

/** A ULID with the time part fixed and `n` in the random part. */
export const goldenId = (n: number): string => `01K6ZQ8W3J${String(n).padStart(16, "0")}`

/** The two sigils and the XP food the player starts with: the common sigil worn. */
export const goldenEntries = {
  chalk: goldenId(900_001),
  storm: goldenId(900_002),
  mix: goldenId(900_003),
  tart: goldenId(900_004),
}

/** A fresh player who already holds two sigils, the common one worn, and two XP foods for the pet once it hatches. */
export const goldenPlayer = (): PlayerState => {
  const fresh = initialState({ characterName: "Golden", timezone: goldenZone, now: goldenStart })
  const owned = (id: string, itemId: string): InventoryEntry => ({
    id,
    itemId,
    acquiredAt: goldenStart,
    source: { kind: "drop", ref: "golden" },
    dye: null,
  })
  return {
    ...fresh,
    holdings: {
      ...fresh.holdings,
      inventory: [
        owned(goldenEntries.chalk, "chalk-sigil"),
        owned(goldenEntries.storm, "storm-sigil"),
        owned(goldenEntries.mix, "trail-mix"),
        owned(goldenEntries.tart, "berry-tart"),
      ],
      equipped: { sigil: goldenEntries.chalk },
    },
  }
}

/**
 * What the write path gives `step` for the log row `logSeq`, received at `now`: rules 14 and catalogue 6, the last
 * the log's rolls could be drawn from again, since catalogue 7 deals from a bigger pool. Rules 14 is the starter rules
 * in every number (starter.test.ts holds it to that), so the log still guards the pricing the starter rules run on.
 */
export const goldenContext = (logSeq: number, now: string, mode: Context["mode"] = { kind: "live" }): Context => ({
  now,
  logSeq,
  rollSeed: goldenSeed,
  rules: rules14,
  catalog: catalog6,
  questPacks: [starterQuestPack],
  mode,
})

/** The log as engine 14 wrote it: its inputs decoded as this engine reads them, what it made left as it was. */
const Golden = Schema.Struct({
  engineVersion: Schema.Number,
  rulesVersion: Schema.Number,
  /** The quest pack it ran under, version 3. */
  questPack: QuestPack,
  steps: Schema.Array(
    Schema.Struct({
      input: Input,
      now: IsoDateTime,
      events: Schema.Unknown,
      rolls: Schema.Array(RollRecord),
      refusal: Schema.NullOr(CommandRefusal),
    }),
  ),
  end: Schema.Unknown,
})

export const golden = Schema.decodeUnknownSync(Golden)(
  JSON.parse(readFileSync(new URL("./fixtures/v1-log.json", import.meta.url), "utf8")),
)
