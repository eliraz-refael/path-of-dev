import type {
  ContentMeasure,
  GradeDimension,
  Graded,
  GradedV2,
  Measure,
  PlayerState,
  PlayerStats,
  PromptRules,
  PromptRulesV2,
  QualityDimension,
  RulesConfig,
  StatCounters,
} from "@pathofdev/schema"
import { localDay } from "./days.ts"

// Graded prompts are priced from their scores, each by the formula of the rubric it was graded with; the player stats
// are counted from stats events and graded prompts, and earn no XP on their own.

/** The quality scores, in the rubric's order. */
export const qualityDimensions: ReadonlyArray<QualityDimension> = [
  "clarity",
  "grammar",
  "specificity",
  "instructive",
  "context",
  "doneCriteria",
  "focus",
]

/** Rubric 2's content measures, in the rubric's order: what the grade is the mean of. */
export const contentMeasures: ReadonlyArray<ContentMeasure> = [
  "intent",
  "grounding",
  "why",
  "successShape",
  "scope",
  "forward",
]

/** Every rubric 2 measure: the content, then the craft and the tone, which only nudge the grade. */
export const measures: ReadonlyArray<Measure> = [...contentMeasures, "craft", "tone"]

/**
 * Rubric 1's grade: the weighted average of its quality scores, 0-10; `regret` is left out, the stats count it. The
 * rules hold at least one weight above zero.
 */
export const gradeV1 = (rules: PromptRules, scores: Readonly<Record<GradeDimension, number>>): number => {
  const total = qualityDimensions.reduce((sum, dimension) => sum + rules.weights[dimension], 0)
  const weighted = qualityDimensions.reduce((sum, dimension) => sum + rules.weights[dimension] * scores[dimension], 0)
  // To the thousandth, so float error in the weights never puts a grade past 10 or just under a threshold.
  return total === 0 ? 0 : Math.round((weighted / total) * 1000) / 1000
}

/**
 * Rubric 2's grade, 0-10 to one decimal: the weighted mean of the content measures the prompt needs (a null one is
 * left out), plus the craft's bonus, the clean spelling's (in full from `fullAtWords` words on) and the tone's nudge,
 * clamped to 0-10, then held under the hostile cap and, for a steer, the steer's. Every number is the rules'. The
 * rules weigh one of the measures that are never null above zero, so the mean always has something to divide by.
 */
export const gradeV2 = (rules: PromptRulesV2, graded: GradedV2): number => {
  const { craft, spelling, tone, caps } = rules
  const scores = graded.measures
  let total = 0
  let weighted = 0
  for (const measure of contentMeasures) {
    const score = scores[measure]
    if (score === null) continue
    total += rules.weights[measure]
    weighted += rules.weights[measure] * score
  }
  const base = total === 0 ? 0 : weighted / total
  // The craft's share of its bonus stops at all of it, should `from` and `span` end below 10.
  const crafted = Math.min(1, Math.max(0, scores.craft - craft.from) / craft.span) * craft.max
  const longEnough = Math.min(graded.words, spelling.fullAtWords) / spelling.fullAtWords
  const spelled = graded.spelledClean ? longEnough * spelling.max : 0
  const toned =
    scores.tone > tone.upFrom
      ? (scores.tone - tone.upFrom) * tone.upPer
      : scores.tone < tone.downFrom
        ? -(tone.downFrom - scores.tone) * tone.downPer
        : 0
  const clamped = Math.min(10, Math.max(0, base + crafted + spelled + toned))
  const hostile = scores.tone <= caps.hostile.toneAtMost ? Math.min(clamped, caps.hostile.grade) : clamped
  const capped = graded.kind === "steer" ? Math.min(hostile, caps.steer.grade) : hostile
  // To the thousandth first, so float error never tips a half the wrong way, then to one decimal, halves up.
  return Math.round(Math.round(capped * 1000) / 100) / 10
}

/** Each rubric's grader, by the version its grades carry: a new rubric can't be graded until it has one. */
const graders: { readonly [V in Graded["rubricVersion"]]: (prompt: PromptRules, graded: GradedOf<V>) => number } = {
  1: (prompt, graded) => gradeV1(prompt, graded.scores),
  2: (prompt, graded) => gradeV2(prompt.v2, graded),
}

/** The grade made with rubric `V`. */
type GradedOf<V extends Graded["rubricVersion"]> = Extract<Graded, { readonly rubricVersion: V }>

/** A prompt's grade, 0-10, by the formula of the rubric it was graded with. */
export const gradeOf = (prompt: PromptRules, graded: Graded): number => gradeBy(prompt, graded)

const gradeBy = <V extends Graded["rubricVersion"]>(prompt: PromptRules, graded: GradedOf<V>): number =>
  graders[graded.rubricVersion](prompt, graded)

/**
 * What a graded prompt is worth, by its rubric: its grade, the XP a grade of 10 earns, the loot chance at 10, and the
 * grade from which the rare weights are raised. Rubric 1's come from its frozen numbers, and rubric 2's from
 * `prompt.v2`, so neither reads the other's.
 */
export interface PromptPrice {
  readonly grade: number
  readonly maxXp: number
  readonly chanceAtTen: number
  readonly greatAt: number
}

const prices: { readonly [V in Graded["rubricVersion"]]: (rules: RulesConfig) => Omit<PromptPrice, "grade"> } = {
  1: (rules) => ({
    maxXp: rules.prompt.maxXp,
    chanceAtTen: rules.loot.promptChanceAtTen,
    greatAt: rules.loot.promptGreatAt,
  }),
  2: (rules) => ({
    maxXp: rules.prompt.v2.maxXp,
    chanceAtTen: rules.prompt.v2.loot.chanceAtTen,
    greatAt: rules.prompt.v2.loot.greatAt,
  }),
}

export const priceOf = (rules: RulesConfig, graded: Graded): PromptPrice => ({
  grade: gradeOf(rules.prompt, graded),
  ...prices[graded.rubricVersion](rules),
})

/** The share, in percent, the `nth` graded prompt of a local day earns; nothing past the last band. */
export const bandPct = (rules: PromptRules, nth: number): number =>
  rules.perDay.find((band) => band.upTo === null || nth <= band.upTo)?.pct ?? 0

/** The context fills a session can cross, under the names the stats give them. */
export const contextThresholds: ReadonlyArray<readonly [keyof PlayerStats["contextCrossed"], number]> = [
  ["pct50", 50],
  ["pct75", 75],
  ["pct100", 100],
]

/** Sessions whose peak a later measurement can still raise; one measured after falling out counts as new. */
export const maxRecentSessions = 20

/** Distinct command names counted; past this, a new name counts as `custom`. */
export const maxCommands = 100

/**
 * One context measurement folded in: the session moves to the end of the recent ones, its peak only rises, and
 * each fill it crosses counts once per session.
 */
export const measureContext = (
  context: StatCounters["context"],
  sessionId: string,
  pct: number,
): StatCounters["context"] => {
  const before = context.recent.find((session) => session.sessionId === sessionId)?.peak ?? null
  const peak = before === null ? pct : Math.max(before, pct)
  const crossed = { ...context.crossed }
  for (const [key, at] of contextThresholds) if (peak >= at && (before === null || before < at)) crossed[key] += 1
  const others = context.recent.filter((session) => session.sessionId !== sessionId)
  return {
    crossed,
    sessions: before === null ? context.sessions + 1 : context.sessions,
    peakSum: context.peakSum + peak - (before ?? 0),
    recent: [...others, { sessionId, peak }].slice(-maxRecentSessions),
  }
}

/** The command name to count a use under, keeping the record to `maxCommands` names, `custom` included. */
export const commandKey = (commands: StatCounters["commands"], command: string): string => {
  if (Object.hasOwn(commands, command)) return command
  // Leave room for `custom`, where the overflow goes.
  const room = maxCommands - (Object.hasOwn(commands, "custom") ? 0 : 1)
  return Object.keys(commands).length < room ? command : "custom"
}

/**
 * `sum` over `count`, 0 before the first: to the thousandth, as a sum of floats over a count would show its float
 * error in the pane, and clamped to `most`, as it can land a hair outside the range.
 */
export const averageOf = (sum: number, count: number, most: number): number =>
  count === 0 ? 0 : Math.min(most, Math.round((sum / count) * 1000) / 1000)

/**
 * The context counters without the session measured last, which is still running and may cross a fill yet: what a
 * count of finished sessions reads, as a context mission does.
 */
export const settledContext = (
  context: StatCounters["context"],
): Pick<StatCounters["context"], "sessions" | "peakSum" | "crossed"> => {
  const running = context.recent[context.recent.length - 1]
  if (running === undefined) return { sessions: context.sessions, peakSum: context.peakSum, crossed: context.crossed }
  const crossed = { ...context.crossed }
  for (const [key, at] of contextThresholds) if (running.peak >= at) crossed[key] -= 1
  return { sessions: context.sessions - 1, peakSum: Math.max(0, context.peakSum - running.peak), crossed }
}

/** The stats the mod draws, as of `now`. */
export const statsOf = (state: PlayerState, now: string): PlayerStats => {
  const { stats, tallies } = state.progress
  const { context, prompts } = stats
  const today = localDay(now, state.timezone)
  return {
    clears: stats.clears,
    compactions: stats.compactions,
    commands: stats.commands,
    contextCrossed: context.crossed,
    contextPeak: {
      lastSession: context.recent[context.recent.length - 1]?.peak ?? 0,
      average: averageOf(context.peakSum, context.sessions, 100),
    },
    prompts: {
      graded: prompts.graded,
      gradedToday: tallies.find((tally) => tally.day === today)?.counts["prompt.graded"] ?? 0,
      averageScore: averageOf(prompts.scoreSum, prompts.graded, 10),
      regretted: prompts.regretted,
    },
    grades: {
      best: prompts.best,
      dimensions: averages(prompts.dimensions, prompts.graded),
      // Only once the counts are rubric 2's, so a rubric 1 player's stats read as they always have.
      ...(prompts.rubric === 2 ? { measures: measureAverages(prompts.measures) } : {}),
    },
  }
}

/** Each rubric 2 measure's average over the prompts that gave it a score, to the thousandth; none before the first. */
const measureAverages = (sums: StatCounters["prompts"]["measures"]): Partial<Record<Measure, number>> =>
  Object.fromEntries(
    measures.flatMap((measure) => {
      const { sum, count } = sums[measure]
      return count === 0 ? [] : [[measure, averageOf(sum, count, 10)]]
    }),
  )

/** Each quality score's average over `graded` prompts, to the thousandth, 0 before the first. */
const averages = (
  sums: Readonly<Record<QualityDimension, number>>,
  graded: number,
): Record<QualityDimension, number> => {
  const average = (dimension: QualityDimension) => averageOf(sums[dimension], graded, 10)
  return {
    clarity: average("clarity"),
    grammar: average("grammar"),
    specificity: average("specificity"),
    instructive: average("instructive"),
    context: average("context"),
    doneCriteria: average("doneCriteria"),
    focus: average("focus"),
  }
}

/** A grade's quality scores added to the running sums the profile averages. */
export const addScores = (
  sums: Readonly<Record<QualityDimension, number>>,
  scores: Readonly<Record<GradeDimension, number>>,
): Record<QualityDimension, number> => ({
  clarity: sums.clarity + scores.clarity,
  grammar: sums.grammar + scores.grammar,
  specificity: sums.specificity + scores.specificity,
  instructive: sums.instructive + scores.instructive,
  context: sums.context + scores.context,
  doneCriteria: sums.doneCriteria + scores.doneCriteria,
  focus: sums.focus + scores.focus,
})

/** A rubric 2 grade's measures added to the running sums the profile averages; a null one adds to neither count. */
export const addMeasures = (
  sums: StatCounters["prompts"]["measures"],
  scores: GradedV2["measures"],
): StatCounters["prompts"]["measures"] => {
  const add = (measure: Measure) => {
    const score = scores[measure]
    const before = sums[measure]
    return score === null ? before : { sum: before.sum + score, count: before.count + 1 }
  }
  return {
    intent: add("intent"),
    grounding: add("grounding"),
    why: add("why"),
    successShape: add("successShape"),
    scope: add("scope"),
    forward: add("forward"),
    craft: add("craft"),
    tone: add("tone"),
  }
}

/** The prompt counters with nothing counted yet, for the prompts of `rubric`. */
export const noPrompts = (rubric: StatCounters["prompts"]["rubric"]): StatCounters["prompts"] => {
  const none = { sum: 0, count: 0 }
  return {
    rubric,
    graded: 0,
    scoreSum: 0,
    regretted: 0,
    best: 0,
    dimensions: { clarity: 0, grammar: 0, specificity: 0, instructive: 0, context: 0, doneCriteria: 0, focus: 0 },
    measures: {
      intent: none,
      grounding: none,
      why: none,
      successShape: none,
      scope: none,
      forward: none,
      craft: none,
      tone: none,
    },
  }
}

/**
 * A graded prompt counted into the prompt counters, which hold one rubric's prompts. The first rubric 2 prompt starts
 * them afresh for rubric 2, so the averages and the best never mix two scales; a rubric 1 prompt after it, from a mod
 * that is behind, counts nowhere here. Only a rubric 1 prompt can be regretted.
 */
export const countPrompt = (
  prompts: StatCounters["prompts"],
  graded: Graded,
  grade: number,
  rules: PromptRules,
): StatCounters["prompts"] => {
  if (graded.rubricVersion === 1) {
    if (prompts.rubric !== 1) return prompts
    return {
      ...prompts,
      graded: prompts.graded + 1,
      scoreSum: prompts.scoreSum + grade,
      regretted: prompts.regretted + (graded.scores.regret >= rules.regretAt ? 1 : 0),
      best: Math.max(prompts.best, grade),
      dimensions: addScores(prompts.dimensions, graded.scores),
    }
  }
  const counted = prompts.rubric === 2 ? prompts : noPrompts(2)
  return {
    ...counted,
    graded: counted.graded + 1,
    scoreSum: counted.scoreSum + grade,
    best: Math.max(counted.best, grade),
    measures: addMeasures(counted.measures, graded.measures),
  }
}
