import type { ServerEvent } from '@pathofdev/schema'
import type { GradeScore, Priced, Pricing, ScoredPrompt } from '../types'
import type { Row, Run } from './cells'
import { cellsOf, cellsOfRow, dim } from './cells'
import { isRecord } from './server'

// The Last prompt card: how the player's last graded prompt was scored, from what it sent and what the server made
// of it. It shows in the Stats tab, on the band under its scores Button, and as `/pathofdev last`'s answer:
//
//   Last prompt · 8.2 · +12 XP · task
//   intent 9  grounding 8  why –  success –  scope 9  forward 8  – didn't apply
//   base 7.6 · craft +0.3 · spelling +0.2 · tone +0.1
//   “Say which test should pass when it's done.”
//
// The grade and the XP are the server's, "pending" until they arrive. The breakdown is rubric 2's formula over the
// prompt's measures and the rules' `prompt.v2` numbers, as the engine's `gradeV2` works it out: the mod can't import
// the engine, so test/card.prop.ts holds the two together. The note is the coach's, which never leaves the machine;
// the misspelled words come only from the mod's memory, and a reload forgets them.

type ContentKey = keyof Pricing['weights']

/** Rubric 2's content measures in its order, as the card labels them. */
const content: ReadonlyArray<{ id: ContentKey; label: string }> = [
  { id: 'intent', label: 'intent' },
  { id: 'grounding', label: 'grounding' },
  { id: 'why', label: 'why' },
  { id: 'successShape', label: 'success' },
  { id: 'scope', label: 'scope' },
  { id: 'forward', label: 'forward' },
]

/** Rubric 1's quality scores in its order, as the card labels them; regret is no part of the grade. */
const qualities: ReadonlyArray<{ id: Exclude<GradeScore, 'regret'>; label: string }> = [
  { id: 'clarity', label: 'clarity' },
  { id: 'grammar', label: 'grammar' },
  { id: 'specificity', label: 'specificity' },
  { id: 'instructive', label: 'instructive' },
  { id: 'context', label: 'context' },
  { id: 'doneCriteria', label: 'done' },
  { id: 'focus', label: 'focus' },
]

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/**
 * The pricing numbers of the rules' `prompt.v2` (`rules.prompt.v2` as the session's answer carries it), each a finite
 * number, the craft's span and the spelling's full words above 0; null otherwise, and the card then shows the measures
 * without a breakdown.
 */
export const pricingOf = (rules: unknown): Pricing | null => {
  const v2: Record<string, unknown> = isRecord(rules) ? rules : {}
  let isWhole = true
  const at = (group: string, key: string, sub?: string): number => {
    const outer = v2[group]
    const inner = isRecord(outer) ? (sub === undefined ? outer : outer[sub]) : undefined
    const value = isRecord(inner) ? finite(inner[key]) : null
    if (value === null) isWhole = false
    return value ?? 0
  }
  const pricing: Pricing = {
    weights: {
      intent: at('weights', 'intent'),
      grounding: at('weights', 'grounding'),
      why: at('weights', 'why'),
      successShape: at('weights', 'successShape'),
      scope: at('weights', 'scope'),
      forward: at('weights', 'forward'),
    },
    craft: { from: at('craft', 'from'), span: at('craft', 'span'), max: at('craft', 'max') },
    spelling: { fullAtWords: at('spelling', 'fullAtWords'), max: at('spelling', 'max') },
    tone: {
      upFrom: at('tone', 'upFrom'),
      upPer: at('tone', 'upPer'),
      downFrom: at('tone', 'downFrom'),
      downPer: at('tone', 'downPer'),
    },
    caps: {
      hostile: { toneAtMost: at('caps', 'toneAtMost', 'hostile'), grade: at('caps', 'grade', 'hostile') },
      steer: { grade: at('caps', 'grade', 'steer') },
    },
  }
  return isWhole && pricing.craft.span > 0 && pricing.spelling.fullAtWords > 0 ? pricing : null
}

/** What a rubric 2 grade is made of: the parts that add up, and what held the sum down, if anything did. */
export type Breakdown = {
  /** The weighted mean of the content measures the prompt needed. */
  base: number
  craft: number
  spelling: number
  tone: number
  /**
   * The last step that lowered or raised the sum: the clamp to 10 (`most`) or to 0 (`least`), the hostile tone's cap
   * or the steer's, at the grade it held to.
   */
  held: { by: 'most' | 'least' | 'hostile' | 'steer'; at: number } | null
  /** The grade, to one decimal, as the server works it out from the same numbers. */
  grade: number
}

/** A rubric 2 prompt as the breakdown reads it. */
export type GradedPrompt = Pick<Extract<ScoredPrompt, { rubric: 2 }>, 'kind' | 'measures' | 'spelledClean' | 'words'>

/**
 * A rubric 2 grade, part by part, by the formula of the engine's `gradeV2` step for step: the weighted mean of the
 * non-null content measures, the craft's bonus (all of it `span` above `from`), the clean spelling's (all of it from
 * `fullAtWords` words), the tone's nudge, a clamp to 0-10, the hostile cap, the steer's, then one decimal.
 */
export const breakdownOf = (pricing: Pricing, graded: GradedPrompt): Breakdown => {
  const { craft, spelling, tone, caps } = pricing
  const scores = graded.measures
  let total = 0
  let weighted = 0
  for (const { id } of content) {
    const score = scores[id]
    if (score === null) continue
    total += pricing.weights[id]
    weighted += pricing.weights[id] * score
  }
  const base = total === 0 ? 0 : weighted / total
  const crafted = Math.min(1, Math.max(0, scores.craft - craft.from) / craft.span) * craft.max
  const longEnough = Math.min(graded.words, spelling.fullAtWords) / spelling.fullAtWords
  const spelled = graded.spelledClean ? longEnough * spelling.max : 0
  const toned =
    scores.tone > tone.upFrom
      ? (scores.tone - tone.upFrom) * tone.upPer
      : scores.tone < tone.downFrom
        ? -(tone.downFrom - scores.tone) * tone.downPer
        : 0
  const sum = base + crafted + spelled + toned
  const clamped = Math.min(10, Math.max(0, sum))
  const hostile = scores.tone <= caps.hostile.toneAtMost ? Math.min(clamped, caps.hostile.grade) : clamped
  const capped = graded.kind === 'steer' ? Math.min(hostile, caps.steer.grade) : hostile
  const held: Breakdown['held'] =
    capped < hostile
      ? { by: 'steer', at: caps.steer.grade }
      : hostile < clamped
        ? { by: 'hostile', at: caps.hostile.grade }
        : clamped !== sum
          ? { by: clamped === 10 ? 'most' : 'least', at: clamped }
          : null
  const grade = Math.round(Math.round(capped * 1000) / 100) / 10
  return { base, craft: crafted, spelling: spelled, tone: toned, held, grade }
}

/**
 * The server's grade and XP for the prompt `id`, from a batch of the stream; null when the batch is none of its.
 * The engine grants XP only above 0, so a batch of the prompt's with no XP for it (the day's last band, the daily cap,
 * a grade of 0) priced it at none: the card then says `+0 XP` beside `grade`, its own working-out, null when it has
 * none (rubric 1, or rules it could not read).
 */
export const pricedOf = (events: ReadonlyArray<ServerEvent>, id: string, grade: number | null): Priced | null => {
  if (!events.some((event) => event.cause === id)) return null
  for (const event of events)
    if (event.type === 'xp.granted' && event.data.reason === 'prompt.graded' && event.cause === id)
      return { grade: event.data.grade ?? grade, xp: event.data.amount }
  return { grade, xp: 0 }
}

/** The grade the card works out for a prompt it keeps: rubric 2's breakdown, by the rules it was graded under. */
const ownGrade = (scored: ScoredPrompt): number | null =>
  scored.rubric === 2 && scored.pricing !== null ? breakdownOf(scored.pricing, scored).grade : null

/**
 * The card's prompt with the server's price, when the batch brings it; as it was otherwise. A batch with no XP for
 * it prices it only while it is pending, so a stream that splits one step's events never undoes the XP.
 */
export const scoredAfter = (scored: ScoredPrompt | null, events: ReadonlyArray<ServerEvent>): ScoredPrompt | null => {
  if (scored === null) return null
  const priced = pricedOf(events, scored.id, ownGrade(scored))
  if (priced === null || (priced.xp === 0 && scored.priced !== null)) return scored
  return { ...scored, priced }
}

/** A prompt just graded by rubric 2, as the card keeps it until the server prices it. */
export const scoredV2Of = (
  id: string,
  graded: GradedPrompt,
  pricing: Pricing | null,
): Extract<ScoredPrompt, { rubric: 2 }> => ({ rubric: 2, id, ...graded, pricing, priced: null })

/** A prompt just graded by rubric 1, as the card keeps it until the server prices it. */
export const scoredV1Of = (
  id: string,
  scores: Readonly<Record<GradeScore, number>>,
  words: number,
): Extract<ScoredPrompt, { rubric: 1 }> => ({ rubric: 1, id, scores, words, priced: null })

/** What the card shows: the prompt, the coach's note when it is about this prompt, and the words to check, if known. */
export type CardInput = {
  scored: ScoredPrompt
  note: string | null
  /** The misspelled words the mod found in the prompt, from its memory; null when it no longer has them. */
  misspelled: ReadonlyArray<string> | null
}

/** One line of the card: its pieces in order, and what goes between two of them. A line wraps between pieces. */
type Line = { pieces: ReadonlyArray<Row>; between: Run }

const dot = dim(' · ')

/** A score's color, as the status line's grade: good from 8, weak under 5, plain between. */
const scoreRun = (score: number, text = String(score)): Run =>
  score >= 8 ? { text, color: 'success' } : score < 5 ? { text, color: 'warning' } : { text }

/** A part of the grade to one decimal with its sign; nothing at all is `+0`. */
export const signed = (part: number): string => {
  const shown = Math.round(part * 10) / 10
  return shown === 0 ? '+0' : shown > 0 ? `+${shown.toFixed(1)}` : shown.toFixed(1)
}

const headOf = (scored: ScoredPrompt): Line => {
  const { priced } = scored
  const title: Row = [{ text: 'Last prompt', color: 'claude', bold: true }]
  const shown = priced?.grade ?? null
  const grade: Array<Row> =
    priced === null ? [[dim('pending')]] : shown === null ? [] : [[scoreRun(shown, shown.toFixed(1))]]
  const xp: Array<Row> = priced === null ? [] : [[{ text: `+${priced.xp} XP`, color: 'suggestion' }]]
  const kind: Array<Row> = scored.rubric === 2 ? [[dim(scored.kind)]] : []
  return { pieces: [title, ...grade, ...xp, ...kind], between: dot }
}

const scorePiece = (label: string, score: number | null): Row => [
  dim(`${label} `),
  score === null ? dim('–') : scoreRun(score),
]

const measuresOf = (scored: ScoredPrompt): Line => {
  if (scored.rubric === 1) {
    const pieces = qualities.map(({ id, label }) => scorePiece(label, scored.scores[id]))
    return { pieces, between: { text: '  ' } }
  }
  const pieces = content.map(({ id, label }) => scorePiece(label, scored.measures[id]))
  const isAnyNull = content.some(({ id }) => scored.measures[id] === null)
  return { pieces: [...pieces, ...(isAnyNull ? [[dim("– didn't apply")]] : [])], between: { text: '  ' } }
}

const heldWords: Record<NonNullable<Breakdown['held']>['by'], string> = {
  steer: 'steer cap',
  hostile: 'hostile cap',
  most: 'at most',
  least: 'at least',
}

/** The spelling part: its bonus, and the words to check while the mod remembers them. */
const spellingPiece = (bonus: string, spelledClean: boolean, misspelled: ReadonlyArray<string> | null): Row => {
  const label = dim('spelling ')
  if (spelledClean) return [label, { text: bonus }]
  const words = misspelled === null || misspelled.length === 0 ? null : misspelled.join(', ')
  if (words === null) return [label, { text: bonus }, dim(' (not clean)')]
  return [label, { text: bonus }, dim(' (check: '), { text: words, color: 'warning' }, dim(')')]
}

const partsOf = (input: CardInput): Line | null => {
  const { scored, misspelled } = input
  if (scored.rubric === 1) return { pieces: [[dim(`regret ${scored.scores.regret}, not in the grade`)]], between: dot }
  const { pricing, measures, spelledClean } = scored
  if (pricing === null) {
    const spelling: Row = [dim('spelling '), spelledClean ? { text: 'clean' } : dim('not clean')]
    return { pieces: [scorePiece('craft', measures.craft), scorePiece('tone', measures.tone), spelling], between: dot }
  }
  const parts = breakdownOf(pricing, scored)
  const part = (label: string, value: number): Row => [dim(`${label} `), { text: signed(value) }]
  const held: Array<Row> =
    parts.held === null ? [] : [[{ text: `${heldWords[parts.held.by]} ${parts.held.at.toFixed(1)}`, color: 'warning' }]]
  return {
    pieces: [
      [dim('base '), { text: parts.base.toFixed(1) }],
      part('craft', parts.craft),
      spellingPiece(signed(parts.spelling), spelledClean, misspelled),
      part('tone', parts.tone),
      ...held,
    ],
    between: dot,
  }
}

/** The note in quotes, a word a piece so it wraps between words. */
const noteOf = (note: string | null): Line | null => {
  if (note === null) return null
  const words = note.split(' ').filter((word) => word !== '')
  const pieces = words.map((word, i): Row => [
    ...(i === 0 ? [dim('“')] : []),
    { text: word },
    ...(i === words.length - 1 ? [dim('”')] : []),
  ])
  return { pieces, between: { text: ' ' } }
}

/** The card's lines, before they are fitted to a width. */
const linesOf = (input: CardInput): Array<Line> =>
  [headOf(input.scored), measuresOf(input.scored), partsOf(input), noteOf(input.note)].filter(
    (line): line is Line => line !== null,
  )

/** A line as rows of `columns` cells at most, broken between pieces; one row when `columns` is null. */
const fitted = (line: Line, columns: number | null): Array<Row> => {
  const rows: Array<Array<Run>> = []
  let row: Array<Run> = []
  for (const piece of line.pieces) {
    const wide = cellsOfRow(row) + cellsOf(line.between.text) + cellsOfRow(piece)
    if (row.length === 0) row = [...piece]
    else if (columns !== null && wide > columns) {
      rows.push(row)
      row = [...piece]
    } else row = [...row, line.between, ...piece]
  }
  if (row.length > 0) rows.push(row)
  return rows
}

/** The card as rows of styled runs `columns` cells wide at most (a line breaks between its pieces), or unbroken. */
export const cardRows = (input: CardInput, columns: number | null): Array<Row> =>
  linesOf(input).flatMap((line) => fitted(line, columns))

/** The card as `/pathofdev last` says it: its lines as plain text. */
export const cardText = (input: CardInput): string =>
  cardRows(input, null)
    .map((row) => row.map((run) => run.text).join(''))
    .join('\n')

/** `/pathofdev last` before any prompt was graded. */
export const noCardText = (minWords: number): string =>
  `No prompt graded yet: type one of ${minWords} words or more, and how it was scored shows here.`

/** The band's Button that opens the card, and the cells it takes as the terminal draws it. */
export const scoresLabel = 'scores'
export const scoresCells = cellsOf(`[ ${scoresLabel} ]`)
