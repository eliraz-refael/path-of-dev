import { it as prop } from '@effect/vitest'
import { Schema } from 'effect'
import { describe, expect } from 'vitest'
import { cellsOf } from '../hooks/cells'
import type { Segment } from '../hooks/status'
import { barLeast, barMost, cellsOfSegments, plainBar, statusSegments } from '../hooks/status'
import type { BandView, StatusFacts } from '../types'

// The status line as the prompt hint draws it, as properties over the row's width: it fits the row, the bar stays
// between its least and its most while a part after it shows, the parts drop from the right end and only for want of
// room, and a row with room past the widest bar is filled to its end.

const between = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }))

const Facts = Schema.Struct({
  level: between(0, 250),
  intoLevel: between(0, 99_999),
  forNextLevel: between(0, 99_999),
  glyph: Schema.Literals(['⚔', '🛡', '']),
  hasPet: Schema.Boolean,
  running: between(0, 12),
  // Hundredths, so a grade that rounds up to a tone's line comes up too.
  grade: Schema.NullOr(between(0, 1_000)),
})
const Room = between(0, 320)

const factsOf = (drawn: typeof Facts.Type): StatusFacts => {
  const view: BandView = {
    name: 'Player',
    level: drawn.level,
    title: 'Apprentice',
    glyph: drawn.glyph,
    xp: {
      total: drawn.intoLevel,
      intoLevel: Math.min(drawn.intoLevel, drawn.forNextLevel),
      forNextLevel: drawn.forNextLevel,
    },
    gold: 0,
    isDev: false,
    pet: drawn.hasPet ? { species: 'fox', name: 'Ember', form: 0, mood: 80 } : null,
  }
  const grade = drawn.grade === null ? null : drawn.grade / 100
  return { link: 'online', view, hint: { say: '', command: '' }, running: drawn.running, grade }
}

const lineOf = (facts: StatusFacts, room: number | null): Array<Segment> => statusSegments('auto', facts, room) ?? []

/** The parts a line shows, by the role that ends each: the missions, the grade, the egg. */
const partsIn = (segments: ReadonlyArray<Segment>): Array<string> =>
  segments.flatMap((one) => {
    if (one.role === 'missions') return ['missions']
    if (one.role === 'good' || one.role === 'weak' || one.role === 'grade') return ['grade']
    return one.role === 'command' ? ['egg'] : []
  })

const barIn = (segments: ReadonlyArray<Segment>): number =>
  cellsOfSegments(segments.filter((one) => one.role === 'filled' || one.role === 'empty'))

/** The cells the head takes with no bar: the level, a blank and the XP. */
const bareOf = (facts: StatusFacts): number => {
  const view = facts.view
  if (view === null) return 0
  const xp = `${view.xp.intoLevel}/${view.xp.forNextLevel} xp`
  return cellsOf(`${view.glyph || '⚔'} Lv ${view.level}`) + 1 + cellsOf(xp)
}

describe('the status line in the prompt hint', () => {
  prop.prop('fits its row, once the row holds the level and the XP', [Facts, Room], ([drawn, room]) => {
    const facts = factsOf(drawn)
    if (room >= bareOf(facts)) expect(cellsOfSegments(lineOf(facts, room))).toBeLessThanOrEqual(room)
  })

  prop.prop('keeps the bar between its least and its most while a part shows', [Facts, Room], ([drawn, room]) => {
    const line = lineOf(factsOf(drawn), room)
    expect(barIn(line)).toBeLessThanOrEqual(barMost)
    if (partsIn(line).length > 0) expect(barIn(line)).toBeGreaterThanOrEqual(barLeast)
  })

  prop.prop('drops parts from the right end, and more only as the row narrows', [Facts, Room], ([drawn, room]) => {
    const facts = factsOf(drawn)
    const all = partsIn(lineOf(facts, null))
    const shown = partsIn(lineOf(facts, room))
    expect(all.slice(0, shown.length)).toEqual(shown)
    expect(partsIn(lineOf(facts, room + 1)).length).toBeGreaterThanOrEqual(shown.length)
  })

  prop.prop('shows every part where they fit beside the least bar', [Facts, Room], ([drawn, room]) => {
    const facts = factsOf(drawn)
    const plain = lineOf(facts, null)
    const tail = cellsOfSegments(plain) - bareOf(facts) - 1 - plainBar
    if (room >= bareOf(facts) + 1 + barLeast + tail) expect(partsIn(lineOf(facts, room))).toEqual(partsIn(plain))
  })

  prop.prop('fills the row to its end once the bar is at its most and a part shows', [Facts, Room], ([drawn, room]) => {
    const line = lineOf(factsOf(drawn), room)
    if (barIn(line) === barMost && partsIn(line).length > 0) expect(cellsOfSegments(line)).toBe(room)
  })

  prop.prop('fills the bar by the share of the level done', [Facts, Room], ([drawn, room]) => {
    const facts = factsOf(drawn)
    const line = lineOf(facts, room)
    const cells = barIn(line)
    const xp = facts.view?.xp ?? { intoLevel: 0, forNextLevel: 0 }
    const share = xp.forNextLevel === 0 ? 0 : xp.intoLevel / xp.forNextLevel
    const filled = cellsOfSegments(line.filter((one) => one.role === 'filled'))
    expect(filled).toBe(Math.round(share * cells))
  })

  prop.prop('reads as the plain line, up to the parts it drops, bar and blanks aside', [Facts, Room], ([drawn, room]) => {
    const facts = factsOf(drawn)
    const words = (segments: ReadonlyArray<Segment>) =>
      segments
        .filter((one) => one.role !== 'filled' && one.role !== 'empty')
        .map((one) => (one.role === 'gap' || one.role === 'separator' ? ' ' : one.text))
        .join('')
        .replace(/ +/g, ' ')
    expect(words(lineOf(facts, null)).startsWith(words(lineOf(facts, room)))).toBe(true)
  })
})
