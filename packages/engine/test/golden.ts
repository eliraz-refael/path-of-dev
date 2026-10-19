import type { Context, InventoryEntry, PlayerState } from "@pathofdev/schema"
import { initialState, starterCatalog, starterQuestPack, starterRules } from "../src/index.ts"

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

/** What the write path gives `step` for the log row `logSeq`, received at `now`. */
export const goldenContext = (logSeq: number, now: string, mode: Context["mode"] = { kind: "live" }): Context => ({
  now,
  logSeq,
  rollSeed: goldenSeed,
  rules: starterRules,
  catalog: starterCatalog,
  questPacks: [starterQuestPack],
  mode,
})
