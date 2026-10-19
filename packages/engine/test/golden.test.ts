import { readFileSync } from "node:fs"
import { CommandRefusal, Input, IsoDateTime, RollRecord } from "@pathofdev/schema"
import type { PlayerState } from "@pathofdev/schema"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { step } from "../src/index.ts"
import { goldenContext, goldenPlayer } from "./golden.ts"

// The guard on v1 pricing: the golden log engine 14 wrote, run again by this engine. Its inputs must decode as they
// did, a live run from the same seed must make the same events and rolls, and a replay from the recorded rolls must end
// at the same state.

const Golden = Schema.Struct({
  engineVersion: Schema.Number,
  rulesVersion: Schema.Number,
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

const golden = Schema.decodeUnknownSync(Golden)(
  JSON.parse(readFileSync(new URL("./fixtures/v1-log.json", import.meta.url), "utf8")),
)

describe("the golden v1 log", () => {
  it("holds about 300 inputs over ten local days, through engine 14", () => {
    expect(golden.engineVersion).toBe(14)
    expect(golden.steps.length).toBeGreaterThanOrEqual(300)
    const prompts = golden.steps.filter((row) => row.input.kind === "client" && row.input.event.type === "prompt.graded")
    expect(prompts.length).toBeGreaterThanOrEqual(100)
  })

  it("makes the same events and rolls when run live from the same seed", () => {
    let state: PlayerState = goldenPlayer()
    for (const [i, row] of golden.steps.entries()) {
      const result = step(state, row.input, goldenContext(i + 1, row.now))
      expect({ seq: i + 1, events: result.events }).toEqual({ seq: i + 1, events: row.events })
      expect(result.rolls).toEqual(row.rolls)
      expect(result.refusal).toEqual(row.refusal)
      state = result.state
    }
    expect(state).toEqual(golden.end)
  })

  it("ends at the same state when replayed from the recorded rolls", () => {
    let state: PlayerState = goldenPlayer()
    for (const [i, row] of golden.steps.entries()) {
      const recorded = { rolls: row.rolls, refusal: row.refusal }
      state = step(state, row.input, goldenContext(i + 1, row.now, { kind: "replay", recorded })).state
    }
    expect(state).toEqual(golden.end)
  })
})
