import { it as prop } from "@effect/vitest"
import type {
  ClientEvent,
  GradeDimension,
  GradedV2,
  Input,
  PlayerState,
  PromptKind,
  QuestPack,
} from "@pathofdev/schema"
import {
  GradeScore,
  GradedV2 as GradedV2Schema,
  Measure,
  QualityDimension,
  QuestPack as QuestPackSchema,
} from "@pathofdev/schema"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  gradeOf,
  gradeV1,
  gradeV2,
  noPrompts,
  priceOf,
  starterQuestPack,
  starterRules,
  statsOf,
  step,
} from "../src/index.ts"
import { golden, goldenContext, goldenPlayer } from "./golden.ts"
import { context, flat, fresh, minutesLater, nextId, session, start } from "./play.ts"

const other = "01K6ZQ8W3J5V7XKQ2M4N6P8R9V"

// Grading v2: rubric 2's formula, rubric 1's kept exactly as it was, each prompt priced by the rubric it names, the
// prompt stats starting afresh at the first rubric 2 prompt, and the missions' filters for each rubric.

const v2 = starterRules.prompt.v2

/** A rubric 2 grade: a plain task, each measure 7 unless given, spelled clean at 60 words. */
const graded = (
  measures: Partial<GradedV2["measures"]> = {},
  options: Partial<Pick<GradedV2, "kind" | "spelledClean" | "words">> = {},
): GradedV2 => ({
  rubricVersion: 2,
  kind: options.kind ?? "task",
  measures: { intent: 7, grounding: 7, why: 7, successShape: 7, scope: 7, forward: 7, craft: 6, tone: 5, ...measures },
  spelledClean: options.spelledClean ?? true,
  words: options.words ?? 60,
  grader: "haiku",
})

/** Today's `gradeOf` as main had it before grading v2, copied here so rubric 1's grade can never drift from it. */
const frozenGradeOf = (
  weights: Readonly<Record<QualityDimension, number>>,
  scores: Readonly<Record<GradeDimension, number>>,
): number => {
  const dimensions = QualityDimension.literals
  const total = dimensions.reduce((sum, dimension) => sum + weights[dimension], 0)
  const weighted = dimensions.reduce((sum, dimension) => sum + weights[dimension] * scores[dimension], 0)
  return total === 0 ? 0 : Math.round((weighted / total) * 1000) / 1000
}

const Weight = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 5 }))
const Scores = Schema.Record(Schema.Literals([...QualityDimension.literals, "regret"]), GradeScore)

describe("rubric 1, frozen", () => {
  prop.prop(
    "grades exactly as main's gradeOf did, for any scores and weights",
    [Schema.Record(QualityDimension, Weight), Scores],
    ([weights, scores]) => {
      const prompt = { ...starterRules.prompt, weights }
      expect(gradeV1(prompt, scores)).toBe(frozenGradeOf(weights, scores))
      expect(gradeOf(prompt, { scores, rubricVersion: 1, words: 12, grader: "haiku" })).toBe(gradeV1(prompt, scores))
    },
  )

  it("keeps its numbers where they were, so the log's rubric 1 prompts replay as they were priced", () => {
    const { weights, maxXp, regretAt, perDay } = starterRules.prompt
    expect({ weights, maxXp, regretAt, perDay }).toEqual({
      weights: { clarity: 1, grammar: 1, specificity: 1, instructive: 1, context: 1, doneCriteria: 1, focus: 1 },
      maxXp: 20,
      regretAt: 5,
      perDay: [
        { upTo: 20, pct: 100 },
        { upTo: 40, pct: 50 },
        { upTo: null, pct: 10 },
      ],
    })
    const { promptChanceAtTen, promptGreatAt, promptGreatRareFactor } = starterRules.loot
    expect([promptChanceAtTen, promptGreatAt, promptGreatRareFactor]).toEqual([0.24, 9, 2])
  })

  it("prices a rubric 1 prompt by its own numbers and a rubric 2 one by v2's, never the other's", () => {
    const scores = flat(8)
    expect(priceOf(starterRules, { scores, rubricVersion: 1, words: 12, grader: "haiku" })).toEqual({
      grade: 8,
      maxXp: 20,
      chanceAtTen: 0.24,
      greatAt: 9,
    })
    const grade = gradeV2(v2, graded())
    expect(priceOf(starterRules, graded())).toEqual({ grade, maxXp: 15, chanceAtTen: 0.175, greatAt: 9 })
    // Tuning rubric 2 never moves a rubric 1 price, nor the other way round.
    const tuned = { ...starterRules, prompt: { ...starterRules.prompt, v2: { ...v2, maxXp: 99 } } }
    expect(priceOf(tuned, { scores, rubricVersion: 1, words: 12, grader: "haiku" }).maxXp).toBe(20)
    const old = { ...starterRules, prompt: { ...starterRules.prompt, maxXp: 99 } }
    expect(priceOf(old, graded()).maxXp).toBe(15)
  })
})

describe("rubric 2's grade", () => {
  // The experiment's seven synthetic controls, their measures the means of five runs rounded as the mod sends them,
  // and the range of grades the experiment saw for each.
  const controls: ReadonlyArray<readonly [string, GradedV2, number, number]> = [
    ["a: fix it, after a failing test", control("steer", [8, 8, null, null, 9, 7, 6, 6], 2), 7.7, 8.0],
    ["b: fix it, no context", control("task", [2, 1, null, 1, 5, 2, 3, 5], 2), 2.2, 2.7],
    ["c: yes, start step 1, after a plan", control("task", [8, 9, null, 7, 9, 8, 7, 6], 4), 8.0, 8.4],
    ["d: a crisp bug report", control("task", [9, 9, 8, 8, 9, 8, 8, 6], 84), 9.2, 9.2],
    ["e: rambling, contradictory", control("task", [5, 5, 3, 3, 2, 3, 5, 6], 61), 3.8, 4.3],
    ["f: rude, cursing", control("steer", [6, 7, 3, null, 8, 4, 4, 1], 10), 3.5, 3.5],
    ["g: a polished, kind discussion", control("discussion", [9, 9, 8, 8, 9, 8, 8, 8], 78), 8.4, 9.5],
  ]

  it("grades the seven controls inside the experiment's ranges, at the plan's numbers", () => {
    const grades = controls.map(([, one]) => gradeV2(v2, one))
    expect(grades).toEqual([7.9, 2.2, 8.3, 9.2, 4, 3.5, 9.3])
    for (const [name, one, least, most] of controls) {
      expect({ name, grade: gradeV2(v2, one) >= least && gradeV2(v2, one) <= most }).toEqual({ name, grade: true })
    }
  })

  it("puts every good control 3.5 or more above every bad one", () => {
    const gradeOfControl = (letter: string) =>
      gradeV2(v2, controls.find(([name]) => name.startsWith(letter))?.[1] ?? graded())
    const good = ["a", "c", "d", "g"].map(gradeOfControl)
    const bad = ["b", "e", "f"].map(gradeOfControl)
    expect(Math.min(...good) - Math.max(...bad)).toBeGreaterThanOrEqual(3.5)
  })

  prop.prop("lies in 0-10, to one decimal", [GradedV2Schema], ([one]) => {
    const grade = gradeV2(v2, one)
    expect(grade).toBeGreaterThanOrEqual(0)
    expect(grade).toBeLessThanOrEqual(10)
    expect(Math.round(grade * 10) / 10).toBe(grade)
  })

  prop.prop(
    "never falls when a measure, or a clean prompt's word count, rises",
    [GradedV2Schema, Measure, Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 }))],
    ([one, measure, by]) => {
      const before = one.measures[measure]
      const measures = before === null ? one.measures : { ...one.measures, [measure]: Math.min(10, before + by) }
      const raised = { ...one, measures }
      expect(gradeV2(v2, raised)).toBeGreaterThanOrEqual(gradeV2(v2, one))
      const longer = { ...one, spelledClean: true, words: one.words + by * 7 }
      expect(gradeV2(v2, longer)).toBeGreaterThanOrEqual(gradeV2(v2, { ...one, spelledClean: true }))
    },
  )

  prop.prop("never falls for clean spelling", [GradedV2Schema], ([one]) => {
    const clean = gradeV2(v2, { ...one, spelledClean: true })
    expect(clean).toBeGreaterThanOrEqual(gradeV2(v2, { ...one, spelledClean: false }))
  })

  prop.prop(
    "leaves a null measure out: the weighted mean of the rest",
    [Schema.Struct({ intent: GradeScore, grounding: GradeScore, scope: GradeScore, forward: GradeScore })],
    ([scores]) => {
      // Craft at its plain 6, a neutral tone and no spelling bonus, so the grade is the mean alone.
      const one = graded({ ...scores, why: null, successShape: null }, { spelledClean: false })
      const { intent, grounding, scope, forward } = v2.weights
      const mean =
        (intent * scores.intent + grounding * scores.grounding + scope * scores.scope + forward * scores.forward) /
        (intent + grounding + scope + forward)
      expect(gradeV2(v2, one)).toBe(Math.round(Math.round(mean * 1000) / 100) / 10)
    },
  )

  prop.prop(
    "holds a hostile prompt at 3.5 and a steer at 8, and a steer told as another kind never grades lower",
    [GradedV2Schema],
    ([one]) => {
      if (one.measures.tone <= 2) expect(gradeV2(v2, one)).toBeLessThanOrEqual(3.5)
      const steer = gradeV2(v2, { ...one, kind: "steer" })
      expect(steer).toBeLessThanOrEqual(8)
      for (const kind of ["task", "question", "discussion"] satisfies Array<PromptKind>) {
        expect(gradeV2(v2, { ...one, kind })).toBeGreaterThanOrEqual(steer)
      }
    },
  )

  it("caps the craft's bonus at its max, should its range end below 10", () => {
    const short = { ...v2, craft: { from: 6, span: 2, max: 0.5 } }
    const plain = gradeV2(short, graded({ craft: 6 }, { spelledClean: false }))
    expect(gradeV2(short, graded({ craft: 10 }, { spelledClean: false }))).toBe(Math.round((plain + 0.5) * 10) / 10)
  })
})

/** A control's measures in the table's order: intent, grounding, why, successShape, scope, forward, craft, tone. */
function control(
  kind: PromptKind,
  [intent, grounding, why, successShape, scope, forward, craft, tone]: readonly [
    number,
    number,
    number | null,
    number | null,
    number,
    number,
    number,
    number,
  ],
  words: number,
): GradedV2 {
  return graded({ intent, grounding, why, successShape, scope, forward, craft, tone }, { kind, words })
}

const promptInput = (data: Extract<ClientEvent, { type: "prompt.graded" }>["data"], minutes = 0): Input => ({
  kind: "client",
  event: { id: nextId(), type: "prompt.graded", occurredAt: minutesLater(minutes), sessionId: session, data },
})
const v1 = (score: number, minutes = 0): Input =>
  promptInput({ scores: { ...flat(score), regret: 0 }, rubricVersion: 1, words: 12, grader: "haiku" }, minutes)
const v2Input = (one: GradedV2, minutes = 0): Input => promptInput(one, minutes)

const playAll = (inputs: ReadonlyArray<Input>, state: PlayerState = fresh()) => {
  const steps = []
  for (const [i, input] of inputs.entries()) {
    const now = input.kind === "client" ? input.event.occurredAt : start
    const result = step(state, input, context(i + 1, now))
    steps.push(result)
    state = result.state
  }
  return { state, steps }
}

/** The XP each graded prompt's grant earned, and the grade it rode on. */
const promptGrants = (steps: ReadonlyArray<ReturnType<typeof step>>) =>
  steps.flatMap((s) =>
    s.events.flatMap((e) => (e.type === "xp.granted" && e.data.reason === "prompt.graded" ? [e.data] : [])),
  )

describe("pricing by rubric in a step", () => {
  it("prices a rubric 2 prompt at v2's maxXp and loot chance, and a rubric 1 one as before", () => {
    const one = graded({ intent: 9, forward: 9 })
    const grade = gradeV2(v2, one)
    const { steps } = playAll([v1(8), v2Input(one, 1)])
    const [first, second] = promptGrants(steps)
    // The first prompt of the day earns its full band: maxXp * grade / 10, rounded down once.
    expect(first).toMatchObject({ amount: Math.floor(20 * 0.8), grade: 8 })
    expect(second).toMatchObject({ amount: Math.floor(15 * grade / 10), grade })
    const chances = steps.map((s) => s.rolls.find((roll) => roll.trigger === "prompt")?.chance)
    expect(chances).toEqual([(0.24 * 8) / 10, (0.175 * grade) / 10])
  })

  prop.prop(
    "a rubric 1 prompt earns, beside rubric 2 ones in its log, what it earns in a rubric 1 log at its place in the day",
    [Schema.Array(Schema.Boolean).check(Schema.isMinLength(1)), GradedV2Schema],
    ([swap, one]) => {
      // The golden log without missions, whose rewards and boosts would follow the swapped prompts' grades, and
      // without its commands, as the pet's hatching waits on the level, and a happy pet adds to the XP.
      const quiet = (i: number, now: string) => ({ ...goldenContext(i, now), questPacks: [] })
      const played = golden.steps.filter((row) => row.input.kind !== "command")
      let prompts = 0
      const inputs = played.map((row) => {
        if (row.input.kind !== "client" || row.input.event.type !== "prompt.graded") return row
        if (swap[prompts++ % swap.length] !== true) return row
        const input: Input = { kind: "client", event: { ...row.input.event, data: one } }
        return { ...row, input }
      })
      const run = (rows: typeof golden.steps) => {
        let state = goldenPlayer()
        const grants: Array<number | null> = []
        for (const [i, row] of rows.entries()) {
          const result = step(state, row.input, quiet(i + 1, row.now))
          if (row.input.kind === "client" && row.input.event.type === "prompt.graded") {
            const rubric = row.input.event.data.rubricVersion
            const grant = result.events.find((e) => e.type === "xp.granted" && e.data.reason === "prompt.graded")
            grants.push(rubric === 2 ? null : grant?.type === "xp.granted" ? grant.data.amount : 0)
          }
          state = result.state
        }
        return grants
      }
      const mixed = run(inputs)
      const plain = run(played)
      expect(mixed).toEqual(plain.map((amount, i) => (mixed[i] === null ? null : amount)))
    },
    { arbitrary: { runs: 20 } },
  )
})

describe("the prompt stats at the switch", () => {
  it("count rubric 1 prompts until the first rubric 2 one, which starts them afresh for rubric 2", () => {
    const one = graded({ intent: 9, why: null })
    const { state, steps } = playAll([v1(10), v1(4, 1), v2Input(one, 2), v1(9, 3), v2Input(graded(), 4)])
    const prompts = state.progress.stats.prompts
    const [first, second] = [gradeV2(v2, one), gradeV2(v2, graded())]
    expect(prompts).toEqual({
      ...noPrompts(2),
      graded: 2,
      scoreSum: first + second,
      best: Math.max(first, second),
      measures: {
        intent: { sum: 16, count: 2 },
        grounding: { sum: 14, count: 2 },
        why: { sum: 7, count: 1 },
        successShape: { sum: 14, count: 2 },
        scope: { sum: 14, count: 2 },
        forward: { sum: 14, count: 2 },
        craft: { sum: 12, count: 2 },
        tone: { sum: 10, count: 2 },
      },
    })
    // The rubric 1 prompt after the switch, from a mod behind, still earns its XP, but counts nowhere in the stats.
    expect(promptGrants(steps).map((grant) => grant.grade)).toEqual([10, 4, first, 9, second])
    const stats = statsOf(state, minutesLater(5))
    const averageScore = Math.round(((first + second) / 2) * 1000) / 1000
    expect(stats.prompts).toEqual({ graded: 2, gradedToday: 5, averageScore, regretted: 0 })
    expect(stats.grades.measures).toEqual({
      intent: 8,
      grounding: 7,
      why: 7,
      successShape: 7,
      scope: 7,
      forward: 7,
      craft: 6,
      tone: 5,
    })
    expect(stats.grades.dimensions.clarity).toBe(0)
  })

  it("leave the measures out of a rubric 1 player's stats, as they always read", () => {
    const { state, steps } = playAll([v1(7)])
    expect(statsOf(state, start).grades).toEqual({ best: 7, dimensions: expect.any(Object) })
    const changed = steps[0]?.events.find((e) => e.type === "stats.changed")
    expect(changed?.type === "stats.changed" && Object.keys(changed.data.stats.grades ?? {})).toEqual([
      "best",
      "dimensions",
    ])
  })

  it("keep a badge earned on rubric 1 when the counts start afresh, and read the new counts for the next", () => {
    const { state, steps } = playAll([v1(10), v2Input(graded({ intent: 3 }), 1)])
    const unlocked = steps.flatMap((s) =>
      s.events.flatMap((e) => (e.type === "achievement.unlocked" ? [e.data.achievementId] : [])),
    )
    expect(unlocked).toContain("perfect-prompt")
    expect(state.progress.stats.prompts.best).toBeLessThan(10)
    expect(state.holdings.achievements.map((badge) => badge.id)).toContain("perfect-prompt")
    // A perfect rubric 2 prompt would unlock it again only if it were locked: it isn't, so nothing new unlocks.
    const ten = { intent: 10, grounding: 10, why: 10, successShape: 10, scope: 10, forward: 10, craft: 10, tone: 10 }
    const perfect = graded(ten)
    const next = step(state, v2Input(perfect, 2), context(3, minutesLater(2)))
    expect(next.state.progress.stats.prompts.best).toBe(10)
    expect(next.events.filter((e) => e.type === "achievement.unlocked")).toEqual([])
  })

  it("replay to the same counts as the live run made", () => {
    const inputs = [v1(6), v2Input(graded(), 1), v1(9, 2), v2Input(graded({ why: null }), 3)]
    const live = playAll(inputs)
    let state = fresh()
    for (const [i, input] of inputs.entries()) {
      const now = input.kind === "client" ? input.event.occurredAt : start
      const recorded = { rolls: live.steps[i]?.rolls ?? [], refusal: null }
      state = step(state, input, context(i + 1, now, starterRules, { kind: "replay", recorded })).state
    }
    expect(state).toEqual(live.state)
  })
})

describe("missions under both rubrics", () => {
  const pack: QuestPack = {
    id: "grading",
    version: 1,
    title: "Grading",
    quests: [
      {
        id: "clear",
        title: "Clear",
        cadence: "daily",
        goal: {
          kind: "fact",
          fact: "prompt.graded",
          count: 9,
          scores: { clarity: 8 },
          v2: { measures: { intent: 8 } },
        },
        rewards: {},
      },
      {
        id: "done",
        title: "Done",
        cadence: "daily",
        goal: {
          kind: "fact",
          fact: "prompt.graded",
          count: 9,
          scores: { doneCriteria: 7 },
          v2: { measures: { successShape: 7 } },
        },
        rewards: {},
      },
      {
        id: "steady",
        title: "Steady",
        cadence: "daily",
        goal: { kind: "fact", fact: "prompt.graded", count: 9, grade: 6, v2: { grade: 7 } },
        rewards: {},
      },
      {
        id: "graded",
        title: "Graded",
        cadence: "daily",
        goal: { kind: "fact", fact: "prompt.graded", count: 9, grade: 6 },
        rewards: {},
      },
      {
        id: "scored",
        title: "Scored",
        cadence: "daily",
        goal: { kind: "fact", fact: "prompt.graded", count: 9, scores: { focus: 5 } },
        rewards: {},
      },
    ],
  }
  const rules = {
    ...starterRules,
    missions: { ...starterRules.missions, daily: { ...starterRules.missions.daily, count: 5 } },
  }
  const progressOf = (inputs: ReadonlyArray<Input>) => {
    let state = fresh()
    for (const [i, input] of inputs.entries()) {
      const now = input.kind === "client" ? input.event.occurredAt : start
      state = step(state, input, { ...context(i + 1, now, rules), questPacks: [pack] }).state
    }
    return Object.fromEntries(state.progress.quests.map((mission) => [mission.questId, mission.progress]))
  }

  it("take a rubric 2 filter on graded prompts only", () => {
    const decode = Schema.decodeUnknownExit(QuestPackSchema)
    const quest = pack.quests[0]
    const withGoal = (goal: object) => ({ ...pack, quests: [{ ...quest, goal }] })
    expect(decode(withGoal({ kind: "fact", fact: "prompt.graded", count: 1, v2: { grade: 7 } }))._tag).toBe("Success")
    expect(decode(withGoal({ kind: "fact", fact: "commit.made", count: 1, v2: { grade: 7 } }))._tag).toBe("Failure")
    // Only the content measures can be asked for: the craft and the tone only nudge a grade.
    const crafted = { kind: "fact", fact: "prompt.graded", count: 1, v2: { measures: { craft: 7 } } }
    const decoded = Schema.decodeUnknownSync(QuestPackSchema)(withGoal(crafted)).quests[0]?.goal
    expect(decoded).toEqual({ ...crafted, v2: { measures: {} } })
    expect(Schema.decodeUnknownSync(QuestPackSchema)(starterQuestPack)).toEqual(starterQuestPack)
  })

  it("count each prompt by its own rubric's filter, both in one window", () => {
    // Rubric 1 meets every filter at 8. Rubric 2: intent 8 meets Clear at a grade of 7.6; intent and grounding 5
    // grade 6.7, which meets Graded's 6, as it names no v2 grade, but not Steady's v2 7. No rubric 2 prompt has the
    // rubric 1 scores Scored names.
    const sharp = graded({ intent: 8 })
    const loose = graded({ intent: 5, grounding: 5 })
    expect([gradeV2(v2, sharp), gradeV2(v2, loose)]).toEqual([7.6, 6.7])
    expect(progressOf([v1(8), v2Input(sharp, 1), v2Input(loose, 2)])).toEqual({
      clear: 2,
      done: 3,
      steady: 2,
      graded: 3,
      scored: 1,
    })
  })

  it("never let a null measure meet a least, and hold a goal with no v2 filter to its grade, never v1 scores", () => {
    const needless = graded({ successShape: null, intent: 9, grounding: 9, scope: 9, forward: 9 })
    expect(gradeV2(v2, needless)).toBeGreaterThanOrEqual(7)
    expect(progressOf([v2Input(needless)])).toEqual({ clear: 1, done: 0, steady: 1, graded: 1, scored: 0 })
  })

  it("join a parallel goal at its rubric 2 grade, or its rubric 1 one when it names none", () => {
    const together = (id: string, v2Grade?: number): QuestPack["quests"][number] => ({
      id,
      title: id,
      cadence: "daily",
      goal: {
        kind: "parallel",
        sessions: 2,
        grade: 7,
        ...(v2Grade === undefined ? {} : { v2: { grade: v2Grade } }),
        withinMinutes: 20,
        count: 9,
      },
      rewards: {},
    })
    const quests = [together("strict", 8.5), together("plain")]
    const parallel: QuestPack = { id: "parallel", version: 1, title: "Parallel", quests }
    const opened = (sessionId: string): Input => ({ kind: "system", event: { type: "session.opened", sessionId } })
    const inSession = (input: Input, sessionId: string): Input =>
      input.kind === "client" ? { kind: "client", event: { ...input.event, sessionId } } : input
    const good = graded({ intent: 8, forward: 8 })
    const great = graded({ intent: 9, grounding: 9, why: 9, successShape: 9, scope: 9, forward: 9, craft: 10 })
    expect([gradeV2(v2, good), gradeV2(v2, great)]).toEqual([7.8, 9.9])
    const inputs = [
      opened(session),
      opened(other),
      inSession(v2Input(good, 1), session),
      inSession(v2Input(good, 2), other),
      inSession(v1(7, 3), session),
      inSession(v1(7, 4), other),
      inSession(v2Input(great, 5), session),
      inSession(v2Input(great, 6), other),
    ]
    let state = fresh()
    for (const [i, input] of inputs.entries()) {
      const now = input.kind === "client" ? input.event.occurredAt : start
      state = step(state, input, { ...context(i + 1, now, rules), questPacks: [parallel] }).state
    }
    // The 7.8s are under strict's 8.5 but over plain's 7; the rubric 1 7s meet both, and the 9.9s both.
    expect(Object.fromEntries(state.progress.quests.map((mission) => [mission.questId, mission.progress]))).toEqual({
      strict: 2,
      plain: 3,
    })
  })
})
