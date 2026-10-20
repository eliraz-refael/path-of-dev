import type { BandView, OfflineHint, StatusFacts } from '../types'
import { blank, cellsOf, cellsOfRow } from './cells'
import type { BandMode } from './collapse'
import { bar, canHatch } from './view'

// The status line under the prompt, as segments, each with a role that says how it draws:
// `⚔ Lv 7 ▰▰▰▱▱ 340/500 xp · 2 missions · last prompt 8.2`. As the engine's plain status line it is one text with a
// short bar. Drawn by the mod under the prompt hint it takes the row's width: the bar grows into the room up to
// `barMost`, and past that the parts after it stand at the row's right end. A row too narrow for every part with the
// bar at `barLeast` drops the parts from the right end first, and with none left the bar shrinks.

/** What a segment is, which says how it draws; a `gap` is blank cells. */
export type StatusRole =
  | 'level'
  | 'filled'
  | 'empty'
  | 'xp'
  | 'separator'
  | 'missions'
  | 'label'
  | 'grade'
  | 'good'
  | 'weak'
  | 'quiet'
  | 'command'
  | 'gap'

export type Segment = { role: StatusRole; text: string }

/** Cells of the bar in the plain status line, which has no width to fill. */
export const plainBar = 5
/** The bar's cells under the prompt hint: never under `barLeast` while a part after it shows, never past `barMost`. */
export const barLeast = 10
export const barMost = 60

const separator: Segment = { role: 'separator', text: ' · ' }

const gap = (cells: number): Segment => ({ role: 'gap', text: blank(cells).text })

/** A grade as the line shows it, to one decimal, and its role by that: good from 8, weak under 5, plain between. */
export const gradeSegment = (grade: number): Segment => {
  const text = grade.toFixed(1)
  const shown = Number(text)
  return { role: shown >= 8 ? 'good' : shown < 5 ? 'weak' : 'grade', text }
}

export const cellsOfSegments = (segments: ReadonlyArray<Segment>): number => cellsOfRow(segments)

export const textOf = (segments: ReadonlyArray<Segment>): string => segments.map((one) => one.text).join('')

/** What to do offline as one text, as the band says it. */
export const hintText = (hint: OfflineHint): string => `${hint.say}${hint.command}`

/** The level, a bar of `cells` (none under one), and the XP into the level. */
const headOf = (view: BandView, cells: number): Array<Segment> => {
  const level: Segment = { role: 'level', text: `${view.glyph || '⚔'} Lv ${view.level}` }
  const xp: Segment = { role: 'xp', text: `${view.xp.intoLevel}/${view.xp.forNextLevel} xp` }
  if (cells < 1) return [level, gap(1), xp]
  const { filled, empty } = bar(view, cells)
  const meter: Array<Segment> = [
    { role: 'filled', text: '▰'.repeat(filled) },
    { role: 'empty', text: '▱'.repeat(empty) },
  ]
  return [level, gap(1), ...meter, gap(1), xp]
}

/** The parts after the bar, in the order the line reads them: the missions running, the last grade, the egg. */
const partsOf = (facts: StatusFacts, view: BandView): Array<Array<Segment>> => {
  const { running, grade } = facts
  const parts: Array<Array<Segment>> = []
  if (running > 0) parts.push([{ role: 'missions', text: `${running} ${running === 1 ? 'mission' : 'missions'}` }])
  if (grade !== null) parts.push([{ role: 'label', text: 'last prompt ' }, gradeSegment(grade)])
  if (canHatch(view)) parts.push([{ role: 'label', text: '🥚 hatch it in ' }, { role: 'command', text: '/pathofdev' }])
  return parts
}

const joined = (parts: ReadonlyArray<ReadonlyArray<Segment>>): Array<Segment> =>
  parts.flatMap((part) => [separator, ...part])

/** The line in `room` cells: as many parts as leave the bar `barLeast`, the bar then as wide as the room has. */
const fitted = (view: BandView, parts: ReadonlyArray<ReadonlyArray<Segment>>, room: number): Array<Segment> => {
  // The head with no bar, and the bar's own blank after it.
  const bare = cellsOfSegments(headOf(view, 0)) + 1
  for (let kept = parts.length; ; kept--) {
    const tail = joined(parts.slice(0, kept))
    const free = room - bare - cellsOfSegments(tail)
    if (kept > 0 && free < barLeast) continue
    const cells = Math.max(0, Math.min(barMost, free))
    // Room past the widest bar goes between the XP and the parts, in the first separator's place.
    const spare = free - cells
    const rest = kept > 0 && spare > 0 ? [gap(spare + cellsOf(separator.text)), ...tail.slice(1)] : tail
    return [...headOf(view, cells), ...rest]
  }
}

/**
 * The status line's segments: the game's essentials, and the egg once it can hatch; offline, what to do about it;
 * before the first snapshot, that it connects. Null in `full`, where the band says it all. With no `room` the bar is
 * `plainBar` cells and every part shows; with `room` the line fits it, as the comment above says.
 */
export const statusSegments = (mode: BandMode, facts: StatusFacts, room: number | null): Array<Segment> | null => {
  if (mode === 'full') return null
  const { link, view, hint } = facts
  const quiet = (text: string): Segment => ({ role: 'quiet', text })
  const command: Segment = { role: 'command', text: hint.command }
  const segments: Array<Segment> =
    link === 'offline'
      ? [quiet('⚔ Path of Dev'), separator, quiet('offline'), separator, quiet(hint.say), command]
      : view === null
        ? [quiet('⚔ Path of Dev'), separator, quiet('connecting…')]
        : room === null
          ? [...headOf(view, plainBar), ...joined(partsOf(facts, view))]
          : fitted(view, partsOf(facts, view), room)
  return segments.filter((one) => one.text !== '')
}

/** Whether two workings-out of the status line say the same, so an unchanged one redraws nothing. */
export const sameFacts = (a: StatusFacts | null, b: StatusFacts | null): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

/** The status line as the engine's plain one says it: `⚔ Lv 7 ▰▰▰▱▱ 340/500 xp · 2 missions · last prompt 8.2`. */
export const statusText = (mode: BandMode, facts: StatusFacts): string | null => {
  const segments = statusSegments(mode, facts, null)
  return segments === null ? null : textOf(segments)
}
