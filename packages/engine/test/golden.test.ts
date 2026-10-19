import type { PlayerState, QuestDef, RollRecord } from "@pathofdev/schema"
import { describe, expect, it } from "vitest"
import { noPrompts, starterQuestPack, step } from "../src/index.ts"
import { golden, goldenContext, goldenPlayer } from "./golden.ts"

// The guard on v1 pricing: the golden log engine 14 wrote, run again by this engine. Its inputs must decode as they
// did, a live run from the same seed must make the same events and rolls, and a replay from the recorded rolls must end
// at the same state. What grading v2 changed on purpose is set aside, and checked on its own: the missions' words,
// which now fit both rubrics, the rules version a roll was made under, and the prompt counters' rubric and measures,
// which a rubric 1 log leaves at rubric 1 and zero.

/** `value` with every mission's `description` left out, at any depth: the words pack 4 rewrote. */
const withoutDescriptions = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutDescriptions)
  if (typeof value !== "object" || value === null) return value
  const entries = Object.entries(value).filter(([key]) => !(key === "description" && Object.hasOwn(value, "questId")))
  return Object.fromEntries(entries.map(([key, field]) => [key, withoutDescriptions(field)]))
}

/** A roll without the rules version it was made under. */
const unversioned = ({ rulesVersion: _rulesVersion, ...roll }: RollRecord) => roll

/** The state as engine 14 kept it: the prompt counters without their rubric and measures. */
const asEngine14 = (state: PlayerState) => {
  const { rubric: _rubric, measures: _measures, ...prompts } = state.progress.stats.prompts
  return { ...state, progress: { ...state.progress, stats: { ...state.progress.stats, prompts } } }
}

/** A quest as both packs agree on it: everything but its words and its rubric 2 filter. */
const sharedPart = (quest: QuestDef) => {
  const { description: _description, ...rest } = quest
  if (rest.goal.kind === "fact" || rest.goal.kind === "parallel") {
    const { v2: _v2, ...goal } = rest.goal
    return { ...rest, goal }
  }
  return rest
}

describe("the golden v1 log", () => {
  it("holds about 300 inputs over ten local days, written by engine 14 under rules 12 and quest pack 3", () => {
    expect([golden.engineVersion, golden.rulesVersion, golden.questPack.version]).toEqual([14, 12, 3])
    expect(golden.steps.length).toBeGreaterThanOrEqual(300)
    const prompts = golden.steps.filter((row) => row.input.kind === "client" && row.input.event.type === "prompt.graded")
    expect(prompts.length).toBeGreaterThanOrEqual(100)
  })

  it("makes the same events and rolls when run live from the same seed", () => {
    let state: PlayerState = goldenPlayer()
    for (const [i, row] of golden.steps.entries()) {
      const result = step(state, row.input, goldenContext(i + 1, row.now))
      const events = withoutDescriptions(result.events)
      expect({ seq: i + 1, events }).toEqual({ seq: i + 1, events: withoutDescriptions(row.events) })
      expect(result.rolls.map(unversioned)).toEqual(row.rolls.map(unversioned))
      expect(result.refusal).toEqual(row.refusal)
      state = result.state
    }
    expect(asEngine14(state)).toEqual(golden.end)
    expect(state.progress.stats.prompts).toMatchObject({ rubric: 1, measures: noPrompts(1).measures })
  })

  it("ends at the same state when replayed from the recorded rolls, the counters still rubric 1's", () => {
    let state: PlayerState = goldenPlayer()
    for (const [i, row] of golden.steps.entries()) {
      const recorded = { rolls: row.rolls, refusal: row.refusal }
      state = step(state, row.input, goldenContext(i + 1, row.now, { kind: "replay", recorded })).state
    }
    expect(asEngine14(state)).toEqual(golden.end)
    expect(state.progress.stats.prompts).toMatchObject({ rubric: 1, measures: noPrompts(1).measures })
  })

  it("draws its missions from pack 4 as from pack 3: the same quests, order and rubric 1 filters", () => {
    expect(starterQuestPack.version).toBe(4)
    expect(starterQuestPack.quests.map(sharedPart)).toEqual(golden.questPack.quests.map(sharedPart))
  })
})
