import type { PlayerState, RulesConfig } from "@pathofdev/schema"
import { addDays, localDay, weekOf } from "./days.ts"

export interface StreakView {
  /** Active days in the streak. */
  readonly days: number
  readonly restDaysLeftThisWeek: number
  /** The streak's first active day, or null when there is none. */
  readonly start: string | null
}

/**
 * The streak as of `today`, computed from the set of active days so a late event still lands on its day. Walking
 * back from `today`, a missed day is forgiven while its week still has a rest day; `today` itself isn't over yet,
 * so it never counts as missed.
 */
export const streakAsOf = (activeDays: ReadonlyArray<string>, today: string, restDaysPerWeek: number): StreakView => {
  const active = new Set(activeDays)
  const earliest = activeDays[0]
  // Rest days taken on a gap count only once an earlier active day bridges it.
  const rests = new Map<string, number>()
  let pending = new Map<string, number>()
  let days = 0
  let start: string | null = null
  if (earliest !== undefined) {
    for (let day = active.has(today) ? today : addDays(today, -1); day >= earliest; day = addDays(day, -1)) {
      if (active.has(day)) {
        for (const [week, count] of pending) rests.set(week, count)
        pending = new Map()
        days++
        start = day
        continue
      }
      const week = weekOf(day)
      const used = pending.get(week) ?? rests.get(week) ?? 0
      if (used >= restDaysPerWeek) break
      pending.set(week, used + 1)
    }
  }
  const restDaysLeftThisWeek = Math.max(0, restDaysPerWeek - (rests.get(weekOf(today)) ?? 0))
  return { days, restDaysLeftThisWeek, start }
}

/**
 * The longest streak reached, given the current one: a save from before the best was kept starts it at 0, and the
 * current streak stands in until it passes it.
 */
export const bestStreakOf = (best: number, currentDays: number): number => Math.max(best, currentDays)

/** The longest streak reached, as of `now`. */
export const bestStreakAsOf = (state: PlayerState, rules: RulesConfig, now: string): number =>
  bestStreakOf(
    state.progress.bestStreak,
    streakAsOf(state.progress.activeDays, localDay(now, state.timezone), rules.streak.restDaysPerWeek).days,
  )
