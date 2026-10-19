import { it as prop } from "@effect/vitest"
import type {
  AchievementDef,
  ContextFill,
  Criterion,
  Input,
  InventoryEntry,
  Metric as MetricType,
  OwnedPet,
  PlayerState,
  RulesConfig,
  ScoringFact,
  Step,
} from "@pathofdev/schema"
import { achievementsIssue, Metric, Rarity, RulesConfig as RulesSchema, ServerEventDraft } from "@pathofdev/schema"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  gaugesOf,
  isEarned,
  ledgerOf,
  measureContext,
  newlyEarned,
  settledContext,
  starterAchievements,
  starterCatalog,
  starterQuestPack,
  starterRules,
  statsOf,
  step,
  unlockedEvent,
  xpForLevel,
} from "../src/index.ts"
import { client, context, fresh, nowOf, play, replay, Script, start, toInputs } from "./play.ts"

// The badges as properties. The oracle reads plain counts, never the state: a test state is written from the counts,
// the engine reads its ledger off that state, and the two must agree on every criterion.
//
//   Counts ──stateOf──▶ PlayerState ──ledgerOf──▶ Ledger ──gaugesOf──▶ earned?
//      └─────────────────────earnedOracle──────────────────────▶ earned?   (must match)

const Int = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }))

/** Peaks drawn often at the fills a session crosses, and just under them. */
const Peak = Schema.Union([Schema.Literals([0, 49, 50, 74, 75, 99, 100]), Int(0, 100)])

const ownable = [...starterCatalog.map((def) => def.id), "no-such-item"]

/** What a player has counted, as plain numbers. The last peak is the session still running. */
const Counts = Schema.Struct({
  commits: Int(0, 8),
  merges: Int(0, 8),
  graded: Int(0, 8),
  /** The average grade, in tenths. */
  meanTenths: Int(0, 100),
  best: Int(0, 10),
  missions: Int(0, 8),
  bestStreak: Int(0, 8),
  xp: Int(0, 2000),
  peaks: Schema.Array(Peak).check(Schema.isMaxLength(10)),
  hatched: Schema.Boolean,
  owned: Schema.Array(Schema.Literals(ownable)).check(Schema.isMaxLength(6)),
})
type Counts = typeof Counts.Type

const sessionOf = (i: number): string => `01K6ZQ8W3K${String(i).padStart(16, "0")}`

const entryOf = (itemId: string, i: number): InventoryEntry => ({
  id: `01K6ZQ8W3M${String(i).padStart(16, "0")}`,
  itemId,
  acquiredAt: start,
  source: { kind: "drop", ref: "0" },
  dye: null,
})

const pet: OwnedPet = {
  species: "fox",
  name: "Ember",
  hatchedAt: start,
  forms: [0],
  form: 0,
  mood: { value: 50, at: start },
  petted: [],
}

/** A player whose state holds exactly these counts, and these badges. */
const stateOf = (counts: Counts, held: ReadonlyArray<string> = []): PlayerState => {
  const state = fresh()
  const { stats } = state.progress
  const measured = counts.peaks.reduce((context, peak, i) => measureContext(context, sessionOf(i), peak), stats.context)
  return {
    ...state,
    progress: {
      ...state.progress,
      xp: { verified: 0, reported: counts.xp },
      totals: { "commit.made": counts.commits, "change.merged": counts.merges, "prompt.graded": counts.graded },
      missionsCompleted: counts.missions,
      bestStreak: counts.bestStreak,
      stats: {
        ...stats,
        context: measured,
        prompts: {
          ...stats.prompts,
          graded: counts.graded,
          scoreSum: (counts.graded * counts.meanTenths) / 10,
          best: counts.best,
        },
      },
    },
    holdings: {
      ...state.holdings,
      pet: counts.hatched ? pet : null,
      inventory: counts.owned.map(entryOf),
      achievements: held.map((id) => ({ id, unlockedAt: start })),
    },
  }
}

const fills: Record<ContextFill, number> = { pct50: 50, pct75: 75, pct100: 100 }

/** The sessions that finished: every one but the last measured. */
const finished = (counts: Counts): ReadonlyArray<number> => counts.peaks.slice(0, -1)

const ownedDefs = (counts: Counts) => starterCatalog.filter((def) => counts.owned.includes(def.id))

/** A Metric counted straight from the counts. */
const metricOracle = (metric: MetricType, counts: Counts): number => {
  switch (metric.kind) {
    case "fact": {
      const totals: Partial<Record<ScoringFact, number>> = {
        "commit.made": counts.commits,
        "change.merged": counts.merges,
        "prompt.graded": counts.graded,
      }
      return totals[metric.fact] ?? 0
    }
    case "streak":
      return counts.bestStreak
    case "level": {
      // The highest level whose XP is reached.
      let level = 0
      while (xpForLevel(starterRules.levelCurve, level + 1) <= counts.xp) level++
      return level
    }
    case "missions":
      return counts.missions
    case "hatched":
      return counts.hatched ? 1 : 0
    case "bestGrade":
      return counts.best
    case "owned":
      return ownedDefs(counts).filter((def) => def.rarity === metric.rarity).length
    case "bandSlots":
      return [...new Set(metric.slots)].filter((slot) =>
        ownedDefs(counts).some((def) => def.category === "bandStyle" && def.slot === slot),
      ).length
    case "calmSessions":
      return finished(counts).filter((peak) => peak < fills[metric.under]).length
  }
}

const mean = (values: ReadonlyArray<number>): number => values.reduce((sum, value) => sum + value, 0) / values.length

/** Whether the counts earn a criterion, worked out without the engine. */
const earnedOracle = (criterion: Criterion, counts: Counts): boolean => {
  if (criterion.kind === "count") return metricOracle(criterion.of, counts) >= criterion.atLeast
  if (criterion.of === "promptGrade") return counts.graded >= criterion.over && counts.meanTenths / 10 >= criterion.atLeast
  const done = finished(counts)
  return done.length >= criterion.over && mean(done) < criterion.below
}

const Goal = Int(1, 5)

/** Criteria with goals a short script can reach. */
const SmallCriterion = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("count"), of: Metric, atLeast: Goal }),
  Schema.Struct({ kind: Schema.Literal("average"), of: Schema.Literal("promptGrade"), atLeast: Int(0, 10), over: Goal }),
  Schema.Struct({
    kind: Schema.Literal("average"),
    of: Schema.Literal("contextPeak"),
    below: Schema.Union([Schema.Literals([50, 75]), Int(0, 100)]),
    over: Goal,
  }),
])

/** Badges with ids d0, d1, … in order, unique by construction, each held or not. */
const SmallDefs = Schema.Array(Schema.Struct({ rarity: Rarity, criterion: SmallCriterion, held: Schema.Boolean })).check(
  Schema.isMaxLength(6),
)

const defsOf = (drawn: typeof SmallDefs.Type): ReadonlyArray<AchievementDef> =>
  drawn.map(({ rarity, criterion }, i) => ({
    id: `d${i}`,
    name: `Badge ${i}`,
    about: "Earned in a test.",
    rarity,
    glyph: "★",
    criterion,
  }))

const heldOf = (drawn: typeof SmallDefs.Type): ReadonlyArray<string> =>
  drawn.flatMap(({ held }, i) => (held ? [`d${i}`] : []))

const rulesWith = (achievements: ReadonlyArray<AchievementDef>): RulesConfig => ({ ...starterRules, achievements })

const at = { rules: starterRules, catalog: starterCatalog, now: start }

/** A stat event: it moves none of the counts a badge reads, so a step on it unlocks only what the state earned. */
const idle = (): Input => client("command.used", 0, undefined, 2)

/** The badges the oracle says the counts earn and the player doesn't hold, in order. */
const oracleUnlocks = (drawn: typeof SmallDefs.Type, counts: Counts): ReadonlyArray<string> =>
  defsOf(drawn)
    .filter((def, i) => !drawn[i]?.held && earnedOracle(def.criterion, counts))
    .map((def) => def.id)

const unlockedIds = (s: Step): ReadonlyArray<string> =>
  s.events.flatMap((event) => (event.type === "achievement.unlocked" ? [event.data.achievementId] : []))

const zero: Counts = {
  commits: 0,
  merges: 0,
  graded: 0,
  meanTenths: 0,
  best: 0,
  missions: 0,
  bestStreak: 0,
  xp: 0,
  peaks: [],
  hatched: false,
  owned: [],
}

describe("gaugesOf", () => {
  prop.prop("earns a criterion exactly when the counts do", [Counts, SmallCriterion], ([counts, criterion]) => {
    expect(isEarned(criterion, ledgerOf(stateOf(counts), at))).toBe(earnedOracle(criterion, counts))
  })

  prop.prop(
    "reads finite gauges, none below 0, a count's goal at least 1",
    [Counts, SmallCriterion],
    ([counts, criterion]) => {
      const gauges = gaugesOf(criterion, ledgerOf(stateOf(counts), at))
      for (const gauge of gauges) {
        expect(Number.isFinite(gauge.current) && gauge.current >= 0).toBe(true)
        if (gauge.sense === "atLeast") expect(gauge.goal).toBeGreaterThanOrEqual(criterion.kind === "count" ? 1 : 0)
      }
    },
  )

  prop.prop("averages as the stats do, the context over finished sessions", [Counts], ([counts]) => {
    const ledger = ledgerOf(stateOf(counts), at)
    expect(ledger.promptGrade.average).toBe(statsOf(stateOf(counts), start).prompts.averageScore)
    const settled = statsOf(stateOf({ ...counts, peaks: finished(counts) }), start)
    expect(ledger.contextPeak.average).toBe(settled.contextPeak.average)
  })

  prop.prop("never earns a 'below' at its mark", [Int(1, 5), Int(0, 100)], ([over, below]) => {
    const state = stateOf({ ...zero, peaks: [...Array.from({ length: over }, () => below), 0] })
    expect(isEarned({ kind: "average", of: "contextPeak", below, over }, ledgerOf(state, at))).toBe(false)
  })
})

describe("settledContext", () => {
  prop.prop("never counts the session still running, however it is measured", [Counts, Peak], ([counts, pct]) => {
    const { context } = stateOf(counts).progress.stats
    const last = counts.peaks.length - 1
    if (last < 0) return
    expect(settledContext(measureContext(context, sessionOf(last), pct))).toEqual(settledContext(context))
  })

  prop.prop("counts a session once a later one is measured", [Counts, Peak], ([counts, pct]) => {
    const { context } = stateOf(counts).progress.stats
    const settled = settledContext(measureContext(context, sessionOf(counts.peaks.length), pct))
    expect(settled.sessions).toBe(context.sessions)
    expect(settled.crossed).toEqual(context.crossed)
    expect(settled.peakSum).toBeCloseTo(context.peakSum, 9)
  })
})

describe("newlyEarned", () => {
  prop.prop("is the badges the counts earn and the player doesn't hold, in order", [Counts, SmallDefs], ([counts, drawn]) => {
    const defs = defsOf(drawn)
    const held = stateOf(counts, heldOf(drawn)).holdings.achievements
    const earned = newlyEarned(defs, held, ledgerOf(stateOf(counts), at)).map((def) => def.id)
    expect(earned).toEqual(oracleUnlocks(drawn, counts))
  })

  prop.prop("splits over a split list", [Counts, SmallDefs, Int(0, 6)], ([counts, drawn, cut]) => {
    const defs = defsOf(drawn)
    const held = stateOf(counts, heldOf(drawn)).holdings.achievements
    const ledger = ledgerOf(stateOf(counts), at)
    const [front, back] = [defs.slice(0, cut), defs.slice(cut)]
    expect(newlyEarned(defs, held, ledger)).toEqual([
      ...newlyEarned(front, held, ledger),
      ...newlyEarned(back, held, ledger),
    ])
  })
})

/** Badges and their banners taken out: what a run under rules without badges would be. */
const unbadged = (s: Step) => ({
  ...s,
  state: { ...s.state, holdings: { ...s.state.holdings, achievements: [] } },
  events: s.events.filter((event) => event.type !== "achievement.unlocked"),
})

describe("step: achievements", () => {
  prop.prop("changes nothing but the badges and their banners", [Script, SmallDefs], ([script, drawn]) => {
    const inputs = toInputs(script)
    const badged = play(inputs, rulesWith(defsOf(drawn)))
    const plain = play(inputs, rulesWith([]))
    expect(badged.steps.map(unbadged)).toEqual(plain.steps)
  })

  prop.prop(
    "unlocks each badge once, for good, at its step's time, after the step's other events",
    [Script, SmallDefs],
    ([script, drawn]) => {
      const defs = defsOf(drawn)
      const inputs = toInputs(script)
      const { steps } = play(inputs, rulesWith(defs))
      let held: PlayerState["holdings"]["achievements"] = []
      for (const [i, s] of steps.entries()) {
        const now = nowOf(inputs[i] as Input)
        const after = s.state.holdings.achievements
        expect(after.slice(0, held.length)).toEqual(held)
        const added = after.slice(held.length)
        expect(added).toEqual(unlockedIds(s).map((id) => ({ id, unlockedAt: now })))
        const first = s.events.findIndex((event) => event.type === "achievement.unlocked")
        if (first >= 0) expect(s.events.slice(first).every((event) => event.type === "achievement.unlocked")).toBe(true)
        for (const event of s.events.slice(Math.max(first, 0))) {
          if (event.type !== "achievement.unlocked") continue
          const def = defs.find((one) => one.id === event.data.achievementId)
          expect(def === undefined ? undefined : unlockedEvent(def)).toEqual(event)
          expect(Schema.decodeUnknownExit(ServerEventDraft)(event)._tag).toBe("Success")
        }
        held = after
      }
      const ids = held.map((achievement) => achievement.id)
      expect(new Set(ids).size).toBe(ids.length)
    },
  )

  prop.prop("unlocks exactly what a saved player's counts earn on their next step", [Counts, SmallDefs], ([counts, drawn]) => {
    const result = step(stateOf(counts, heldOf(drawn)), idle(), context(1, start, rulesWith(defsOf(drawn))))
    expect(unlockedIds(result)).toEqual(oracleUnlocks(drawn, counts))
  })

  const prestige: Input = { kind: "command", command: { id: sessionOf(99), type: "character.prestige", data: {} } }
  const carry: Input = { kind: "system", event: { type: "xp.carried", amount: 0, rulesVersion: 1 } }

  prop.prop("unlocks nothing on a refused command or on bookkeeping, whatever is earned", [Counts, SmallDefs], ([counts, drawn]) => {
    const rules = rulesWith(defsOf(drawn))
    const state = stateOf(counts)
    const refused = step(state, prestige, context(1, start, rules))
    expect(refused.refusal).not.toBeNull()
    expect(refused.state).toBe(state)
    expect(refused.events).toEqual([])
    const carried = step(state, carry, context(1, start, rules))
    expect(carried.state.holdings.achievements).toEqual([])
    expect(unlockedIds(carried)).toEqual([])
  })

  prop.prop(
    "unlocks badges added later on the next step, and those held never again",
    [Script, SmallDefs, Int(0, 6)],
    ([script, drawn, cut]) => {
      const defs = defsOf(drawn)
      const inputs = toInputs(script)
      const before = play(inputs, rulesWith(defs.slice(0, cut)))
      const now = nowOf(inputs[inputs.length - 1] ?? idle())
      const next = step(before.state, idle(), context(inputs.length + 1, now, rulesWith(defs)))
      const held = new Set(before.state.holdings.achievements.map((achievement) => achievement.id))
      expect(unlockedIds(next).some((id) => held.has(id))).toBe(false)
      expect(unlockedIds(next).every((id) => defs.slice(cut).some((def) => def.id === id))).toBe(true)
    },
  )

  prop.prop("unlocks the same in a replay of the log as in the live run", [Script, SmallDefs], ([script, drawn]) => {
    const rules = rulesWith(defsOf(drawn))
    const inputs = toInputs(script)
    const live = play(inputs, rules)
    const recorded = live.steps.map((s) => ({ rolls: s.rolls, refusal: s.refusal }))
    const again = replay(inputs, recorded, rules)
    expect(again.state).toEqual(live.state)
    expect(again.events).toEqual(live.events)
  })
})

/** A busy few days of the work missions ask for, well-graded prompts included, so missions complete. */
const Busy = Schema.Array(
  Schema.Struct({
    kind: Schema.Literals(["prompt.graded", "commit.made", "tests.passed", "session.cleared", "command.used"]),
    gap: Int(0, 180),
    second: Schema.Boolean,
    n: Int(6, 10),
  }),
).check(Schema.isMinLength(10), Schema.isMaxLength(60))

describe("step: the missions count", () => {
  prop.prop("counts every mission completed, and never falls", [Busy], ([script]) => {
    let state = fresh()
    let completed = 0
    for (const [i, input] of toInputs(script).entries()) {
      const result = step(state, input, { ...context(i + 1, nowOf(input)), questPacks: [starterQuestPack] })
      completed += result.events.filter((event) => event.type === "quest.completed").length
      expect(result.state.progress.missionsCompleted).toBeGreaterThanOrEqual(state.progress.missionsCompleted)
      state = result.state
    }
    expect(state.progress.missionsCompleted).toBe(completed)
  })
})

/**
 * The counts with one starter badge's measure set `short` of its goal, the rest as drawn. An average is short on
 * either side: too few counted, or the average not there.
 */
const reach = (def: AchievementDef, counts: Counts, short: number, side: "count" | "average"): Counts => {
  const { criterion } = def
  if (criterion.kind === "average") {
    if (criterion.of === "promptGrade") {
      return side === "count"
        ? { ...counts, graded: criterion.over - short, meanTenths: 100 }
        : { ...counts, graded: criterion.over, meanTenths: criterion.atLeast * 10 - short }
    }
    const sessions = side === "count" ? criterion.over - short : criterion.over
    const peak = side === "count" ? 0 : criterion.below - 1 + short
    return { ...counts, peaks: [...Array.from({ length: sessions }, () => peak), 100] }
  }
  const goal = criterion.atLeast - short
  const metric = criterion.of
  switch (metric.kind) {
    case "fact": {
      const field = metric.fact === "commit.made" ? "commits" : metric.fact === "change.merged" ? "merges" : "graded"
      return { ...counts, [field]: goal }
    }
    case "streak":
      return { ...counts, bestStreak: goal }
    case "level":
      return { ...counts, xp: xpForLevel(starterRules.levelCurve, criterion.atLeast) - short }
    case "missions":
      return { ...counts, missions: goal }
    case "hatched":
      return { ...counts, hatched: goal > 0 }
    case "bestGrade":
      return { ...counts, best: goal }
    case "owned": {
      const others = counts.owned.filter((id) => starterCatalog.find((item) => item.id === id)?.rarity !== metric.rarity)
      const ofRarity = starterCatalog.filter((item) => item.rarity === metric.rarity).slice(0, goal)
      return { ...counts, owned: [...others, ...ofRarity.map((item) => item.id)] }
    }
    case "bandSlots": {
      const styled = (id: string) => starterCatalog.find((item) => item.id === id)?.category === "bandStyle"
      const styles = metric.slots
        .slice(0, goal)
        .flatMap((slot) => starterCatalog.find((item) => item.category === "bandStyle" && item.slot === slot)?.id ?? [])
      return { ...counts, owned: [...counts.owned.filter((id) => !styled(id)), ...styles] }
    }
    case "calmSessions":
      return { ...counts, peaks: [...Array.from({ length: goal }, () => 0), 100] }
  }
}

/**
 * A badge as a rules file might hold it, often wrong: an id off the pattern, a name or text jsonb can't keep or out of
 * length, a glyph too wide, a goal under 1, or a verified fact, which nothing counts yet.
 */
const DirtyDef = Schema.Struct({
  id: Schema.Literals(["a", "b", "Bad id", ""]),
  name: Schema.Literals(["Fine", "", "\u0000", "x\ud800", "x".repeat(33)]),
  about: Schema.Literals(["Earned.", "", "\udc00"]),
  glyph: Schema.Literals(["★", "", "123456789"]),
  rarity: Rarity,
  fact: Schema.Literals(["commit.made", "prompt.graded", "review.acted_on", "issue.closed"]),
  atLeast: Int(-1, 3),
})
type DirtyDef = typeof DirtyDef.Type

const isClean = (raw: DirtyDef): boolean =>
  ["a", "b"].includes(raw.id) &&
  raw.name === "Fine" &&
  raw.about === "Earned." &&
  raw.glyph === "★" &&
  ["commit.made", "prompt.graded"].includes(raw.fact) &&
  raw.atLeast >= 1

const unlocksNext = (def: AchievementDef, counts: Counts): boolean =>
  unlockedIds(step(stateOf(counts), idle(), context(1, start))).includes(def.id)

describe("starter badges", () => {
  it("are these, by id, name and rarity: an id is kept for good", () => {
    expect(starterAchievements.map((def) => [def.id, def.name, def.rarity])).toEqual([
      ["first-commit", "First commit", "common"],
      ["first-merge", "First merge", "common"],
      ["hatched", "Hatchling", "common"],
      ["first-mission", "Mission accomplished", "common"],
      ["commits-100", "Committed", "uncommon"],
      ["merges-50", "Merge train", "rare"],
      ["prompts-500", "Wordsmith", "rare"],
      ["streak-7", "A week strong", "uncommon"],
      ["streak-30", "Habit formed", "epic"],
      ["streak-100", "Unbroken", "legendary"],
      ["perfect-prompt", "Perfect prompt", "rare"],
      ["sharp-prompter", "Sharp prompter", "epic"],
      ["light-context", "Light touch", "rare"],
      ["calm-25", "Never past 75", "rare"],
      ["level-10", "Level 10", "common"],
      ["level-25", "Level 25", "rare"],
      ["level-50", "Level 50", "legendary"],
      ["legendary-find", "Legendary find", "epic"],
      ["full-band", "Full band", "epic"],
    ])
  })

  it("are in rules the schema takes, and the starter catalogue can satisfy", () => {
    expect(Schema.decodeUnknownSync(RulesSchema)(starterRules)).toEqual(starterRules)
    expect(achievementsIssue(starterRules.achievements, starterCatalog)).toBeUndefined()
  })

  prop.prop(
    "rules take badges exactly when each is well formed and their ids differ, and keep them as given",
    [Schema.Array(DirtyDef).check(Schema.isMaxLength(3))],
    ([raws]) => {
      const achievements = raws.map(({ fact, atLeast, ...def }) => ({
        ...def,
        criterion: { kind: "count", of: { kind: "fact", fact }, atLeast },
      }))
      const rules = { ...starterRules, achievements }
      const clean = raws.every(isClean) && new Set(raws.map((raw) => raw.id)).size === raws.length
      expect(Schema.is(RulesSchema)(rules)).toBe(clean)
      if (clean) expect(Schema.decodeUnknownSync(RulesSchema)(rules)).toEqual(rules)
    },
  )

  prop.prop("each stays locked one short of its goal, and unlocks on the next step at it", [Counts], ([counts]) => {
    for (const def of starterAchievements) {
      for (const side of def.criterion.kind === "average" ? (["count", "average"] as const) : (["count"] as const)) {
        expect(unlocksNext(def, reach(def, counts, 1, side)), `${def.id} one short (${side})`).toBe(false)
        expect(unlocksNext(def, reach(def, counts, 0, side)), `${def.id} at its goal (${side})`).toBe(true)
      }
    }
  })
})
