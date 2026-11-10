import type { DayTally, PlayerState, Progress, RulesConfig, Season, SeasonPassed, SeasonView } from "@pathofdev/schema"
import { addDays, startOfDay } from "./days.ts"

// The devpass: a season's second, short track beside the level, which ordinary play fills. It is a function of the
// days played, so a replay of the same inputs lands on the same pass whatever order they came in:
//
//   value(d)  = tally[d].pass × (rested(d) ? factor : 1)        tally[d].pass: the XP day d counted, at most perDay
//   rested(d) = d is the season's first day, or d − 1 is not an active day
//   pass XP   = Σ value(d) over the season's days + a bonus for each mission completed on one
//
// The engine keeps one counter per season (`holdings.seasons`). Each step adds the bonuses it granted, and the change
// in Σ value over the days the tallies keep, after the step minus before it. A day older than the tallies can no
// longer change, so its value is already in the counter, and `prune` keeps the day before the oldest tally while that
// is a season day, so each kept day's look-back is there.

/** The days after a season's last on which play dated inside it can still arrive: the edge's 7. */
export const settleDays = 7

const isIn = (season: Season, day: string): boolean => season.startsOn <= day && day <= season.endsOn

/** The season whose days hold local day `day`, if any. */
export const seasonOn = (rules: RulesConfig, day: string): Season | undefined =>
  rules.seasons?.find((season) => isIn(season, day))

/** The XP a day counted toward a pass, once `amount` more is granted on it: held to the pass's cap. */
export const passAfter = (season: Season, tally: DayTally | undefined, amount: number): number =>
  Math.min(season.pass.perDay, (tally?.pass ?? 0) + amount)

/** Whether play on `day` counts double: on the season's first day, and on a day after one without play. */
export const isRested = (season: Season, activeDays: ReadonlyArray<string>, day: string): boolean =>
  day === season.startsOn || !activeDays.includes(addDays(day, -1))

/** What a day of the season adds to its pass, as the progress stands. */
export const valueOf = (season: Season, progress: Pick<Progress, "tallies" | "activeDays">, day: string): number => {
  const pass = progress.tallies.find((tally) => tally.day === day)?.pass ?? 0
  return pass === 0 ? 0 : pass * (isRested(season, progress.activeDays, day) ? season.pass.rested.factor : 1)
}

/**
 * How a step changed the value of the season's days the tallies keep after it: each kept day's value after, less its
 * value before. A day the step pruned had stopped changing, so it is left out on both sides.
 */
export const recount = (season: Season, before: Progress, after: Progress): number =>
  after.tallies
    .filter((tally) => isIn(season, tally.day))
    .reduce((sum, { day }) => sum + valueOf(season, after, day) - valueOf(season, before, day), 0)

/** The pass XP each tier is reached at, in order. */
export const tierTotals = (season: Season): ReadonlyArray<number> => {
  let total = 0
  return season.pass.tiers.map((tier) => (total += tier.xp))
}

/** The tiers `xp` reaches: those of the pass, then one for each `beyond.xp` past its last. */
export const tiersReached = (season: Season, xp: number): number => {
  const totals = tierTotals(season)
  const last = totals[totals.length - 1] ?? 0
  const within = totals.filter((total) => total <= xp).length
  return xp < last ? within : within + Math.floor((xp - last) / season.pass.beyond.xp)
}

/** The player's record of a season's pass: none played reads as nothing yet. */
export const passedOf = (state: PlayerState, id: string): SeasonPassed =>
  state.holdings.seasons?.find((passed) => passed.id === id) ?? { id, xp: 0, tier: 0 }

/** The holdings' seasons with `passed` in place of its season's record, or after the others when it is the first. */
export const withPassed = (state: PlayerState, passed: SeasonPassed): ReadonlyArray<SeasonPassed> => {
  const seasons = state.holdings.seasons ?? []
  return seasons.some((one) => one.id === passed.id)
    ? seasons.map((one) => (one.id === passed.id ? passed : one))
    : [...seasons, passed]
}

/**
 * The season the mod shows on local day `today`: the one running, else one settling, else the next to come, else the
 * last one over; none when the rules have no season. Running comes first, as a season may start while the one before
 * it still settles.
 */
export const seasonShown = (rules: RulesConfig, today: string): Season | undefined => {
  const seasons = rules.seasons ?? []
  const first = (status: SeasonView["status"]) => seasons.find((season) => statusOf(season, today) === status)
  return first("running") ?? first("settling") ?? first("upcoming") ?? seasons[seasons.length - 1]
}

const statusOf = (season: Season, today: string): SeasonView["status"] =>
  today < season.startsOn
    ? "upcoming"
    : today <= season.endsOn
      ? "running"
      : today <= addDays(season.endsOn, settleDays)
        ? "settling"
        : "over"

/** A season as the snapshot carries it, on the player's local day `today`. */
export const seasonViewOf = (state: PlayerState, season: Season, today: string): SeasonView => {
  const { pass } = season
  const { xp, tier } = passedOf(state, season.id)
  const totals = tierTotals(season)
  const last = totals[totals.length - 1] ?? 0
  const status = statusOf(season, today)
  const tiers = pass.tiers.map((one, i) => ({ ...one, at: totals[i] ?? 0 }))
  const shown = Math.min(tier, tiers.length)
  // The bar runs from the tier reached to the next, or over each `beyond.xp` past the last.
  const from = tier < tiers.length ? (totals[tier - 1] ?? 0) : last + (tier - tiers.length) * pass.beyond.xp
  const forTier = tier < tiers.length ? (pass.tiers[tier]?.xp ?? pass.beyond.xp) : pass.beyond.xp
  const running = status === "running"
  const tally = state.progress.tallies.find((one) => one.day === today)
  return {
    id: season.id,
    name: season.name,
    status,
    startsAt: startOfDay(season.startsOn, state.timezone),
    endsAt: startOfDay(addDays(season.endsOn, 1), state.timezone),
    xp,
    tier: shown,
    tiers,
    beyond: { xp: pass.beyond.xp, gold: pass.beyond.gold, reached: tier - shown },
    intoTier: Math.min(forTier, Math.max(0, xp - from)),
    forTier,
    today: {
      pass: running ? (tally?.pass ?? 0) : 0,
      cap: pass.perDay,
      factor: pass.rested.factor,
      doubled: running && isRested(season, state.progress.activeDays, today),
    },
  }
}
