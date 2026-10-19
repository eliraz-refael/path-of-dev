import type { PluginOptions } from 'claude-code'
import type { BandView, Link, Opening } from '../types'
import { bar, canHatch } from './view'

// The band as the `band` option has it, and the status line beside it. In `auto` the band is shut at rest and opens
// for a moment of play: a gain, a celebration, the pet's reaction or its bubble, the player's focus on it. It stays
// open while the moment lasts and `holdMs` past its end, then shuts. The status line under the prompt carries the
// game's essentials meanwhile, and all the time in `line`, where the band never opens.

/** The `band` option: shut until something happens (the default), always open as it was, or never open. */
export type BandMode = 'auto' | 'full' | 'line'

export const bandModeOf = (options: PluginOptions): BandMode => {
  const value = options['band']
  return value === 'full' || value === 'line' ? value : 'auto'
}

/** How long the band stays open in `auto` once its moment has ended, or after a gain that plays no celebration. */
export const holdMs = 6_000

/** What holds the band open while it lasts. */
export type Moments = {
  /** A celebration plays, or waits to with the prompt idle. */
  celebrates: boolean
  /** The pet plays a reaction, or has one waiting, with the band free. */
  reacts: boolean
  /** The pet coach's bubble shows, or a line waits to. */
  speaks: boolean
  /** The band's focus ring is on one of its elements. */
  isFocused: boolean
}

export const isHeld = (moments: Moments): boolean =>
  moments.celebrates || moments.reacts || moments.speaks || moments.isFocused

const heldOpen: Opening = { until: null }

/**
 * The band's opening at clock `now`, from the last and whether a moment holds it: held with no end while one lasts,
 * open `holdMs` more from its end, shut (null) once that has passed.
 */
export const openingAfter = (opening: Opening | null, held: boolean, now: number): Opening | null => {
  if (held) return heldOpen
  if (opening === null) return null
  if (opening.until === null) return { until: now + holdMs }
  return opening.until > now ? opening : null
}

/** A moment came at clock `now`: the band opens, or stays open, `holdMs` from now at least. */
export const kicked = (opening: Opening | null, now: number): Opening =>
  opening !== null && (opening.until === null || opening.until >= now + holdMs) ? opening : { until: now + holdMs }

export const sameOpening = (a: Opening | null, b: Opening | null): boolean =>
  a === null || b === null ? a === b : a.until === b.until

/** Whether the band draws: always in `full`, never in `line`, and in `auto` while it is open. */
export const isBandShown = (mode: BandMode, opening: Opening | null): boolean =>
  mode === 'full' || (mode === 'auto' && opening !== null)

/** What the status line reads from: the link, the character, what to do offline, the missions running, the grade. */
export type StatusFacts = {
  link: Link
  view: BandView | null
  /** What to do while offline: start the server, sign in, or wait on it. */
  hint: string
  running: number
  /** The grade the server gave the last prompt it priced in this session; null before one. */
  grade: number | null
}

/** Cells of the status line's XP bar. */
const barCells = 5

/**
 * The status line: `⚔ Lv 7 ▰▰▰▱▱ 340/500 xp · 2 missions · last prompt 8.2`, and the egg once it can hatch; offline,
 * what to do about it; before the first snapshot, that it connects. Null in `full`, where the band says it all.
 */
export const statusText = (mode: BandMode, facts: StatusFacts): string | null => {
  if (mode === 'full') return null
  const { link, view, hint, running, grade } = facts
  if (link === 'offline') return `⚔ Path of Dev · offline · ${hint}`
  if (view === null) return '⚔ Path of Dev · connecting…'
  const { filled, empty } = bar(view, barCells)
  const meter = `${'▰'.repeat(filled)}${'▱'.repeat(empty)}`
  const parts = [`${view.glyph || '⚔'} Lv ${view.level} ${meter} ${view.xp.intoLevel}/${view.xp.forNextLevel} xp`]
  if (running > 0) parts.push(`${running} ${running === 1 ? 'mission' : 'missions'}`)
  if (grade !== null) parts.push(`last prompt ${grade.toFixed(1)}`)
  if (canHatch(view)) parts.push('🥚 hatch it in /pathofdev')
  return parts.join(' · ')
}
