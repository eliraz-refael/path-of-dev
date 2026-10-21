import type {
  AchievementDef,
  ContextFill,
  Context,
  Criterion,
  ItemDef,
  Metric,
  PlayerState,
  Progress,
  Rarity,
  ServerEventDraft,
  Slot,
} from "@pathofdev/schema"
import { levelOf } from "./derive.ts"
import { averageOf, settledContext } from "./stats.ts"
import { bestStreakAsOf } from "./streak.ts"

// Achievements: after an accepted step, every badge the rules define and the player doesn't hold yet is checked
// against what the state counts, and those earned unlock, for good. A badge is never taken back, so a count that
// falls later (an item salvaged, a rebalance) keeps it.
//
//   state ─▶ ledgerOf ─▶ Ledger (plain numbers, read once)
//                          │
//   defs ─▶ not held ─▶ gaugesOf(criterion, ledger) ─▶ every gauge met? ─▶ newlyEarned
//                                                                            │
//                       unlock: holdings.achievements ++ {id, unlockedAt: now}, achievement.unlocked per badge
//
// A criterion counts a Metric to a goal, or averages the prompt grades or the context peaks over enough of them.
// Context counts read finished sessions only (`settledContext`): the session measured last may cross a fill yet.
// A public profile reads the same gauges off the same ledger for the badges still locked (`progressOf`).

/** What the badges read off a state: each Metric's number, and the two lifetime averages with what they cover. */
export interface Ledger {
  readonly totals: Progress["totals"]
  readonly streak: number
  readonly level: number
  readonly missions: number
  readonly hatched: number
  /** The prompt counters' best grade: one rubric's prompts, from its first on, as `promptGrade` averages them. */
  readonly bestGrade: number
  /** Catalogue items owned at each rarity, each item once. */
  readonly owned: Readonly<Record<Rarity, number>>
  /** The slots the player owns a band style for. */
  readonly bandSlots: ReadonlySet<Slot>
  /** Finished sessions that never reached each fill. */
  readonly calm: Readonly<Record<ContextFill, number>>
  readonly promptGrade: Average
  readonly contextPeak: Average
}

interface Average {
  readonly count: number
  readonly average: number
}

/** One measure of a badge's progress: met when `current` is at least `goal`, or under it for a `below`. */
export interface Gauge {
  readonly current: number
  readonly goal: number
  readonly sense: "atLeast" | "below"
}

const noneOwned: Record<Rarity, number> = { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0 }

/** The catalogue items the player owns, counted by rarity, and the band slots their styles fill. */
const ownedOf = (state: PlayerState, catalog: ReadonlyArray<ItemDef>): Pick<Ledger, "owned" | "bandSlots"> => {
  const ids = new Set(state.holdings.inventory.map((entry) => entry.itemId))
  const mine = catalog.filter((def) => ids.has(def.id))
  return {
    owned: mine.reduce((owned, def) => ({ ...owned, [def.rarity]: owned[def.rarity] + 1 }), noneOwned),
    bandSlots: new Set(mine.flatMap((def) => (def.category === "bandStyle" && def.slot !== null ? [def.slot] : []))),
  }
}

/** Everything the badges read, worked out once per step. */
export const ledgerOf = (state: PlayerState, context: Pick<Context, "rules" | "catalog" | "now">): Ledger => {
  const { progress, holdings } = state
  const { prompts } = progress.stats
  const settled = settledContext(progress.stats.context)
  return {
    totals: progress.totals,
    streak: bestStreakAsOf(state, context.rules, context.now),
    level: levelOf(state, context.rules).level,
    missions: progress.missionsCompleted,
    hatched: holdings.pet === null ? 0 : 1,
    bestGrade: prompts.best,
    ...ownedOf(state, context.catalog),
    calm: {
      pct50: settled.sessions - settled.crossed.pct50,
      pct75: settled.sessions - settled.crossed.pct75,
      pct100: settled.sessions - settled.crossed.pct100,
    },
    promptGrade: { count: prompts.graded, average: averageOf(prompts.scoreSum, prompts.graded, 10) },
    contextPeak: { count: settled.sessions, average: averageOf(settled.peakSum, settled.sessions, 100) },
  }
}

/** A Metric's number in the ledger. */
export const metricOf = (metric: Metric, ledger: Ledger): number => {
  switch (metric.kind) {
    case "fact":
      return ledger.totals[metric.fact] ?? 0
    case "streak":
      return ledger.streak
    case "level":
      return ledger.level
    case "missions":
      return ledger.missions
    case "hatched":
      return ledger.hatched
    case "bestGrade":
      return ledger.bestGrade
    case "owned":
      return ledger.owned[metric.rarity]
    case "bandSlots":
      return [...new Set(metric.slots)].filter((slot) => ledger.bandSlots.has(slot)).length
    case "calmSessions":
      return ledger.calm[metric.under]
  }
}

/** How far a criterion is: one gauge for a count, and for an average how many it covers and where it stands. */
export const gaugesOf = (criterion: Criterion, ledger: Ledger): ReadonlyArray<Gauge> => {
  if (criterion.kind === "count") {
    return [{ current: metricOf(criterion.of, ledger), goal: criterion.atLeast, sense: "atLeast" }]
  }
  const { count, average } = ledger[criterion.of]
  const covered: Gauge = { current: count, goal: criterion.over, sense: "atLeast" }
  return criterion.of === "promptGrade"
    ? [covered, { current: average, goal: criterion.atLeast, sense: "atLeast" }]
    : [covered, { current: average, goal: criterion.below, sense: "below" }]
}

export const isMet = (gauge: Gauge): boolean =>
  gauge.sense === "atLeast" ? gauge.current >= gauge.goal : gauge.current < gauge.goal

export const isEarned = (criterion: Criterion, ledger: Ledger): boolean => gaugesOf(criterion, ledger).every(isMet)

/** Whether the player holds the badge `id`. */
export const hasEarned = (held: PlayerState["holdings"]["achievements"], id: string): boolean =>
  held.some((achievement) => achievement.id === id)

/** The badges the ledger earns that the player doesn't hold yet, in the rules' order. */
export const newlyEarned = (
  defs: ReadonlyArray<AchievementDef>,
  held: PlayerState["holdings"]["achievements"],
  ledger: Ledger,
): ReadonlyArray<AchievementDef> => defs.filter((def) => !hasEarned(held, def.id) && isEarned(def.criterion, ledger))

/** The banner for a badge: its name, at its rarity, with its glyph. */
export const unlockedEvent = (def: AchievementDef): ServerEventDraft => ({
  type: "achievement.unlocked",
  data: { achievementId: def.id, title: def.name, tier: def.rarity, glyph: def.glyph },
})

interface Unlocked {
  readonly state: PlayerState
  readonly events: ReadonlyArray<ServerEventDraft>
}

/** The badges kept as held from `at`, each with its banner. */
export const unlock = (state: PlayerState, defs: ReadonlyArray<AchievementDef>, at: string): Unlocked =>
  defs.length === 0
    ? { state, events: [] }
    : {
        state: {
          ...state,
          holdings: {
            ...state.holdings,
            achievements: [...state.holdings.achievements, ...defs.map((def) => ({ id: def.id, unlockedAt: at }))],
          },
        },
        events: defs.map(unlockedEvent),
      }

/** How far a badge the player doesn't hold yet is. */
export interface BadgeProgress {
  readonly id: string
  readonly gauges: ReadonlyArray<Gauge>
}

/**
 * How far each badge the player doesn't hold yet is, in the rules' order, read off one ledger: what a public profile
 * draws on a locked badge. Worked out when a page is drawn, never kept.
 */
export const progressOf = (
  state: PlayerState,
  context: Pick<Context, "rules" | "catalog" | "now">,
): ReadonlyArray<BadgeProgress> => {
  const held = state.holdings.achievements
  const locked = context.rules.achievements.filter((def) => !hasEarned(held, def.id))
  if (locked.length === 0) return []
  const ledger = ledgerOf(state, context)
  return locked.map((def) => ({ id: def.id, gauges: gaugesOf(def.criterion, ledger) }))
}

/** Every badge the state now earns and the player doesn't hold, unlocked as of the step's time. */
export const unlockAchievements = (
  state: PlayerState,
  context: Pick<Context, "rules" | "catalog" | "now">,
): Unlocked => {
  const defs = context.rules.achievements
  const held = state.holdings.achievements
  // Most steps of a player who holds every badge: nothing to read.
  if (defs.every((def) => hasEarned(held, def.id))) return { state, events: [] }
  return unlock(state, newlyEarned(defs, held, ledgerOf(state, context)), context.now)
}
