import type { GradeDimension, QualityDimension, ServerEvent } from '@pathofdev/schema'
import type { PluginOptions } from 'claude-code'
import type { CoachMemory, Graded, Said } from '../types'
import type { Row } from './cells'
import { cellsOf, clip } from './cells'
import type { Walker } from './pet-motion'
import { shownGrade, wellGradedAt } from './pet-motion'

// The pet coach: a short tip the pet says in a speech bubble beside itself on band row 2, about the prompt the player
// typed last. It makes no model call of its own: the tip is the grader's note when that is a sensible one, else a line
// written here for the prompt's weakest score. All of it stays on this machine; the server only ever gets the scores.
//
//   grade ─▶ gradedOf ─▶ remembered ─▶ CoachMemory.last (the note stays here)
//   the XP it earned ─▶ heardOf ─▶ unasked ─▶ Said ─▶ phasesOf ─▶ the bubble, once the pet's reactions have played
//   /pathofdev pet tip ─▶ asked ─▶ Said
//
// It never nags. It speaks up now and then after a prompt graded 7 or more: one unasked bubble in 3 graded prompts
// at most, and never about the same score twice in a row. After a weaker prompt it stays quiet, unless the player set
// the `coach` option to `always`; even then it only ever suggests, and never scolds.

/** The `coach` option: speak after good prompts (the default), after every graded prompt, or never unasked. */
export type Coach = 'good' | 'always' | 'off'

export const coachOf = (options: PluginOptions): Coach => {
  const value = options['coach']
  return value === 'always' || value === 'off' ? value : 'good'
}

/** How long a bubble stands: a line alone the whole 8 s; praise and a tip share them, the tip the longer. */
export const bubbleMs = 8_000
export const praiseMs = 3_000
/** At most one unasked bubble in this many graded prompts. */
export const everyGraded = 3
/** A score this or lower, as the coach weighs it, is worth a tip after a good prompt. */
export const tipAt = 6
/** Grammar matters least: the coach weighs it this much kinder, so it is picked only when it is very low. */
const grammarSlack = 3
/** The fewest cells a bubble takes, its quotes included: with less room, the band shows none. */
export const minBubble = 16

export const freshCoach: CoachMemory = { last: null, sinceBubble: null, lastTopic: null, lines: {} }

// The scores in the order the coach prefers them on a tie: the ones a prompt most often lacks first.
const ranked: ReadonlyArray<GradeDimension> = [
  'doneCriteria',
  'specificity',
  'context',
  'instructive',
  'clarity',
  'focus',
  'regret',
  'grammar',
]
const quality: ReadonlyArray<QualityDimension> = [
  'doneCriteria',
  'specificity',
  'context',
  'instructive',
  'clarity',
  'focus',
  'grammar',
]

type Scores = Readonly<Record<GradeDimension, number>>

/** How weak a score is, 0 the weakest: regret is upside down, as much regret is the weak one; grammar weighs kinder. */
const weaknessOf = (scores: Scores, dimension: GradeDimension): number =>
  dimension === 'regret'
    ? 10 - scores.regret
    : dimension === 'grammar'
      ? Math.min(10, scores.grammar + grammarSlack)
      : scores[dimension]

const strengthOf = (scores: Scores, dimension: QualityDimension): number =>
  dimension === 'grammar' ? scores.grammar - grammarSlack : scores[dimension]

/** The scores, weakest first, a tie in the coach's order. */
export const weakestOf = (scores: Scores): Array<GradeDimension> =>
  [...ranked].sort((a, b) => weaknessOf(scores, a) - weaknessOf(scores, b))

/** The quality scores, strongest first, a tie in the coach's order. Regret is no strength to praise. */
export const strongestOf = (scores: Scores): Array<QualityDimension> =>
  [...quality].sort((a, b) => strengthOf(scores, b) - strengthOf(scores, a))

/** The plain mean of the quality scores: the grade until the server's arrives, with the starter's equal weights. */
export const meanOf = (scores: Scores): number =>
  quality.reduce((sum, dimension) => sum + scores[dimension], 0) / quality.length

/** A prompt graded 7 or more, to one decimal as the band shows it: the line the pet hops at. */
export const isGood = (grade: number): boolean => shownGrade(grade) >= wellGradedAt

// The pet's own lines, `{name}` where its name goes. Each score has a few, said by turns, never one twice in a row.

const tips: Record<GradeDimension, ReadonlyArray<string>> = {
  doneCriteria: [
    "{name} wonders how you'll know it's done: a passing test? a behaviour?",
    '{name} likes a finish line: which test should pass?',
    "{name} asks what should work once it's done.",
  ],
  specificity: [
    '{name} sniffs for a file name or the exact error.',
    '{name} wonders which file or function you mean.',
    '{name} says pasting the error helps Claude find it.',
  ],
  context: [
    '{name} wonders why: a line of why helps Claude choose.',
    '{name} says the goal behind the ask shapes the fix.',
    '{name} would mention what you already tried.',
  ],
  instructive: [
    '{name} asks what should change, and where.',
    '{name} says naming one constraint saves a round trip.',
    '{name} likes a hint at the approach you want.',
  ],
  clarity: [
    "{name} tilts its head: what's the one thing you want?",
    '{name} would lead with the ask, then the details.',
    '{name} likes the ask said in one plain sentence.',
  ],
  focus: [
    '{name} suggests one ask at a time; the rest can wait.',
    '{name} says smaller steps keep each one sharp.',
    '{name} would start with the piece that matters most.',
  ],
  regret: [
    '{name} noticed a change of plan: say why, and Claude adapts.',
    '{name} says naming what to keep helps a change of course.',
    '{name} thinks a quick plan first saves undoing later.',
  ],
  grammar: ['{name} spotted a typo or two; a reread helps it land.', '{name} says tidy words leave less to guess.'],
}

const praises: Record<QualityDimension, ReadonlyArray<string>> = {
  doneCriteria: ['{name} loves a clear finish line!', "{name} knows just when it's done. Lovely."],
  specificity: ['{name} loves that you named the exact spot!', 'Precise pointers, {name} cheers.'],
  context: ['{name} loves knowing the why!', 'Great context, {name} thinks.'],
  instructive: ['{name} likes how actionable that was!', 'Clear directions, {name} cheers.'],
  clarity: ['{name} got that in one read!', 'Crystal clear, {name} thinks.'],
  focus: ['Nice and focused, {name} says!', '{name} likes one sharp ask.'],
  grammar: ['{name} admires that tidy writing.', 'Neatly written, {name} thinks.'],
}

/** The line after the last one said of this kind and score; the lines it said, with this one. */
const nextLine = (
  lines: Readonly<Record<string, number>>,
  key: string,
  options: ReadonlyArray<string>,
): { line: string; lines: Readonly<Record<string, number>> } => {
  const at = ((lines[key] ?? -1) + 1) % Math.max(1, options.length)
  return { line: options[at] ?? '', lines: { ...lines, [key]: at } }
}

/**
 * What the pet says about a graded prompt, never about `avoid`: after a good prompt, praise for its strongest score and
 * a tip when a score is low; after a weaker one, a tip alone. The tip is the grader's note when the note is about the
 * weakest score (which it most likely is), else the pet's own line. Null when there is nothing to say.
 */
export const sayAbout = (
  graded: Graded,
  lines: Readonly<Record<string, number>>,
  avoid: GradeDimension | null,
): { said: Said | null; lines: Readonly<Record<string, number>> } => {
  const good = isGood(graded.grade)
  const weakest = weakestOf(graded.scores)
  const low = weakest.filter((one) => one !== avoid && (!good || weaknessOf(graded.scores, one) <= tipAt))
  const tip = low[0] ?? null
  const praise = good ? (strongestOf(graded.scores).find((one) => one !== avoid) ?? null) : null
  let said = lines
  const advice = (dimension: GradeDimension): string => {
    if (graded.note !== null && dimension === weakest[0]) return graded.note
    const next = nextLine(said, `tip:${dimension}`, tips[dimension])
    said = next.lines
    return next.line
  }
  const cheer = (dimension: QualityDimension): string => {
    const next = nextLine(said, `praise:${dimension}`, praises[dimension])
    said = next.lines
    return next.line
  }
  const out = [...(praise === null ? [] : [cheer(praise)]), ...(tip === null ? [] : [advice(tip)])]
  const topic = tip ?? praise
  return { said: topic === null || out.length === 0 ? null : { lines: out, topic }, lines: said }
}

/** The prompt just graded, as the coach keeps it: its grade is the scores' mean until the server's arrives. */
export const gradedOf = (id: string, scores: Scores, note: string | null): Graded => ({
  id,
  scores,
  note,
  grade: meanOf(scores),
  said: null,
})

/** The memory with a prompt just graded: it is the last, and one more graded prompt since the last bubble. */
export const remembered = (memory: CoachMemory, graded: Graded): CoachMemory => ({
  ...memory,
  last: graded,
  sinceBubble: memory.sinceBubble === null ? null : memory.sinceBubble + 1,
})

/** The XP a graded prompt earned, in a batch of the stream: the prompt's event id (the batch's cause) and its grade. */
export const heardOf = (events: ReadonlyArray<ServerEvent>): { id: string; grade: number } | null => {
  for (const event of events)
    if (event.type === 'xp.granted' && event.data.reason === 'prompt.graded' && event.data.grade !== undefined)
      return event.cause === null ? null : { id: event.cause, grade: event.data.grade }
  return null
}

/**
 * The server graded the prompt: the memory with its grade, and what the pet says unasked about it, if anything. Only
 * about the last prompt graded, while the pet is on the band to say it (`onBand`), as the `coach` option allows, at
 * most once in `everyGraded` graded prompts, and not about the last bubble's score. A prompt the player already asked
 * about gets no bubble of its own.
 */
export const unasked = (
  memory: CoachMemory,
  heard: { id: string; grade: number },
  coach: Coach,
  onBand: boolean,
): { memory: CoachMemory; said: Said | null } => {
  const { last } = memory
  if (last === null || last.id !== heard.id) return { memory, said: null }
  const graded: Graded = { ...last, grade: heard.grade }
  const kept: CoachMemory = { ...memory, last: graded }
  const isQuiet = memory.sinceBubble !== null && memory.sinceBubble < everyGraded
  const isAllowed = coach === 'always' || (coach === 'good' && isGood(heard.grade))
  if (!onBand || !isAllowed || isQuiet || last.said !== null) return { memory: kept, said: null }
  const { said, lines } = sayAbout(graded, memory.lines, memory.lastTopic)
  if (said === null) return { memory: kept, said: null }
  return { memory: { ...kept, last: { ...graded, said }, lines, sinceBubble: 0, lastTopic: said.topic }, said }
}

/** `/pathofdev pet tip`: what the pet says about the last graded prompt, weak or not; the same when asked again. */
export const asked = (memory: CoachMemory): { memory: CoachMemory; said: Said | null } => {
  const { last } = memory
  if (last === null) return { memory, said: null }
  if (last.said !== null) return { memory, said: last.said }
  const { said, lines } = sayAbout(last, memory.lines, null)
  return { memory: { ...memory, lines, last: { ...last, said } }, said }
}

const named = (line: string, name: string): string => line.split('{name}').join(name)

/** The bubble's lines, the pet's name in them, and how long each stands: praise first, briefly, then the tip. */
export const phasesOf = (said: Said, name: string): Array<{ text: string; ms: number }> =>
  said.lines.map((line, i) => ({
    text: named(line, name),
    ms: said.lines.length === 1 ? bubbleMs : i === 0 ? praiseMs : bubbleMs - praiseMs,
  }))

/** What the pet says, as the command's reply. */
export const tipText = (said: Said, name: string): string => said.lines.map((line) => named(line, name)).join(' ')

/** The reply before any prompt was graded. */
export const noTipText = (name: string | null): string =>
  `${name ?? 'Your pet'} has no tip yet: ask again after a prompt you type is graded.`

/** Whether the pet may speak now: on the band, awake, its reactions played, and the band free of turns and shows. */
export const canSpeak = (walker: Walker, hidden: boolean, free: boolean): boolean =>
  !hidden && free && !walker.asleep && walker.act === null && walker.queue.length === 0

/** A text cut to `room` cells: at a word when that keeps most of it, else at a glyph, an ellipsis where it was cut. */
const fitted = (text: string, room: number): string => {
  if (cellsOf(text) <= room) return text
  let kept = ''
  for (const word of text.split(' ')) {
    const next = kept === '' ? word : `${kept} ${word}`
    if (cellsOf(next) + 1 > room) break
    kept = next
  }
  const trimmed = kept.replace(/[\s,;:.-]+$/, '')
  if (trimmed !== '' && cellsOf(trimmed) * 2 >= room) return `${trimmed}…`
  return clip([{ text }], room)
    .map((run) => run.text)
    .join('')
}

/** The bubble beside the pet, in `cells` at most: the line in quotes, cut to fit; null when the band has no room. */
export const bubbleRow = (text: string, cells: number): Row | null =>
  cells < minBubble ? null : [{ text: '“', dim: true }, { text: fitted(text, cells - 2) }, { text: '”', dim: true }]

/** Whether every line of what the pet says shows whole in a bubble of `cells`. */
export const fitsWhole = (said: Said, name: string, cells: number): boolean =>
  cells >= minBubble && said.lines.every((line) => cellsOf(named(line, name)) + 2 <= cells)
