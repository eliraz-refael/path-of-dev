import type { ContentMeasure, GradeDimension, QualityDimension, RulesConfig, ServerEvent } from '@pathofdev/schema'
import type { PluginOptions } from 'claude-code'
import type { CoachMemory, Graded, GradeMeasure, Said } from '../types'
import type { Row } from './cells'
import { cellsOf, cutAtWord } from './cells'
import type { Rubric } from './grade'
import type { Walker } from './pet-motion'
import { shownGrade, wellGradedAt } from './pet-motion'

// The pet coach: a short tip the pet says in a speech bubble beside itself on band row 2, about the prompt the player
// typed last. It makes no model call of its own: the tip is the grader's note when that is a sensible one, else a line
// written here for the prompt's weakest score. All of it stays on this machine; the server only ever gets the scores.
// A rubric 2 grade is weighed by its six content measures alone: its craft and tone are never a tip, and a hostile
// tone gets one gentle line in praise's place.
//
//   grade ─▶ gradedOf ─▶ remembered ─▶ CoachMemory.last (the note stays here)
//   the XP it earned ─▶ heardOf ─▶ unasked ─▶ Said ─▶ phasesOf ─▶ the bubble, once the pet's reactions have played
//   /pathofdev pet tip ─▶ asked ─▶ Said
//
// It never nags. It speaks up now and then after a prompt graded 7 or more (8 by rubric 2, whose grades run higher):
// one unasked bubble in 3 graded prompts at most, and never about the same score twice in a row. After a weaker
// prompt it stays quiet, unless the player set the `coach` option to `always`; even then it only ever suggests, and
// never scolds.

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

// Rubric 2's content measures in the order the coach prefers them on a tie: the ones the grading experiment's prompts
// most often lacked first.
const content: ReadonlyArray<ContentMeasure> = ['successShape', 'why', 'grounding', 'forward', 'scope', 'intent']

type MeasureScores = Readonly<Record<GradeMeasure, number | null>>

/** Craft joins the praise only this high, exceptional writing; tone never does. */
const praiseCraftAt = 9
/** A tone this or lower is hostile, as the starter rules' `caps.hostile.toneAtMost` says, unless the rules say else. */
export const hostileToneAt = 2

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** The tone the rules cap a grade at as hostile (`prompt.v2.caps.hostile.toneAtMost`), else the starter's 2. */
export const hostileToneOf = (rules: Partial<RulesConfig>): number => {
  const caps: unknown = isRecord(rules.prompt?.v2) ? rules.prompt.v2.caps : undefined
  const hostile: unknown = isRecord(caps) ? caps['hostile'] : undefined
  const at: unknown = isRecord(hostile) ? hostile['toneAtMost'] : undefined
  return typeof at === 'number' && Number.isFinite(at) ? at : hostileToneAt
}

/** The measures in `order` the prompt gave a score, with it: a null one, which the prompt didn't need, is left out. */
const scored = <M extends GradeMeasure>(
  measures: MeasureScores,
  order: ReadonlyArray<M>,
): Array<{ measure: M; score: number }> =>
  order.flatMap((measure) => {
    const score = measures[measure]
    return score === null ? [] : [{ measure, score }]
  })

const weakestScoredOf = (measures: MeasureScores): Array<{ measure: ContentMeasure; score: number }> =>
  scored(measures, content).sort((a, b) => a.score - b.score)

/** The content measures the prompt needed, weakest first, a tie in the coach's order. Craft and tone are no tip. */
export const weakestMeasuresOf = (measures: MeasureScores): Array<ContentMeasure> =>
  weakestScoredOf(measures).map((one) => one.measure)

/** The content measures the prompt needed, strongest first, a tie in the coach's order; craft last, from a 9. */
export const strongestMeasuresOf = (measures: MeasureScores): Array<ContentMeasure | 'craft'> => {
  const craft = measures.craft !== null && measures.craft >= praiseCraftAt ? scored(measures, ['craft']) : []
  return [...scored<ContentMeasure | 'craft'>(measures, content), ...craft]
    .sort((a, b) => b.score - a.score)
    .map((one) => one.measure)
}

/** The plain mean of the content measures the prompt needed: the grade until the server's arrives. */
export const measuresMeanOf = (measures: MeasureScores): number => {
  const given = scored(measures, content)
  return given.length === 0 ? 0 : given.reduce((sum, one) => sum + one.score, 0) / given.length
}

/** The rubric a remembered grade was made with: one kept before rubric 2 says none, and is rubric 1's. */
export const rubricOfGraded = (graded: Graded): Rubric => (graded.rubric === 2 ? 2 : 1)

/** A prompt graded at the rubric's line or more (7, or 8 by rubric 2), to one decimal as the band shows it. */
export const isGood = (grade: number, rubric: Rubric = 1): boolean => shownGrade(grade) >= wellGradedAt[rubric]

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

// Rubric 2's lines, today's where a measure carries on from a score: what done looks like from done criteria, the why
// from context, grounding from specificity, scope from focus and intent from clarity.

const measureTips: Record<ContentMeasure, ReadonlyArray<string>> = {
  successShape: [
    "{name} wonders how you'll know it's done: a passing test? a behaviour?",
    '{name} likes a finish line: which test should pass?',
    '{name} asks what a good answer should give you.',
  ],
  why: [
    '{name} wonders why: a line of why helps Claude choose.',
    '{name} says the goal behind the ask shapes the fix.',
    '{name} would mention what you already tried.',
  ],
  grounding: [
    '{name} sniffs for a file name or the exact error.',
    '{name} wonders which file or function you mean.',
    '{name} says pasting the error helps Claude find it.',
  ],
  forward: [
    "{name} wonders what's new here: a decision, a fact, a method?",
    '{name} says one new detail moves Claude further.',
    '{name} would say what you decided, so Claude can act on it.',
  ],
  scope: [
    '{name} suggests one ask at a time; the rest can wait.',
    '{name} says smaller steps keep each one sharp.',
    '{name} would start with the piece that matters most.',
  ],
  intent: [
    "{name} tilts its head: what's the one thing you want?",
    '{name} would lead with the ask, then the details.',
    '{name} likes the ask said in one plain sentence.',
  ],
}

const measurePraises: Record<ContentMeasure | 'craft', ReadonlyArray<string>> = {
  successShape: ['{name} loves a clear finish line!', "{name} knows just what you're after. Lovely."],
  why: ['{name} loves knowing the why!', 'Great context, {name} thinks.'],
  grounding: ['{name} loves that you named the exact spot!', 'Precise pointers, {name} cheers.'],
  forward: ['{name} loves how that moves things on!', 'Real progress, {name} cheers.'],
  scope: ['Nice and focused, {name} says!', '{name} likes one sharp ask.'],
  intent: ['{name} got that in one read!', 'Crystal clear, {name} thinks.'],
  craft: ['{name} admires how well that is put.', 'Beautifully written, {name} thinks.'],
}

/** Said in praise's place about a hostile prompt: never a scold. */
const gentle: ReadonlyArray<string> = ['{name} works best with kind words.']

const praiseWords = [
  'great',
  'nice',
  'good',
  'excellent',
  'perfect',
  'well[ -]done',
  'lovely',
  'awesome',
  'solid',
  'strong',
  'clear',
  'nothing',
  'no change',
  'looks good',
]
const praising = new RegExp(`^(${praiseWords.join('|')})\\b`, 'i')

/**
 * A note that praises rather than suggests: the rubric lets the grader praise a prompt nothing would improve, and
 * praise is no tip.
 */
export const isPraise = (note: string): boolean => note.endsWith('!') || praising.test(note)

/** The line after the last one said of this kind and score; the lines it said, with this one. */
const nextLine = (
  lines: Readonly<Record<string, number>>,
  key: string,
  options: ReadonlyArray<string>,
): { line: string; lines: Readonly<Record<string, number>> } => {
  const at = ((lines[key] ?? -1) + 1) % Math.max(1, options.length)
  return { line: options[at] ?? '', lines: { ...lines, [key]: at } }
}

type Lines = Readonly<Record<string, number>>
type Spoken = { said: Said | null; lines: Lines }

/**
 * What the pet says about a graded prompt, never about `avoid`: after a good prompt, praise for its strongest score and
 * a tip when a score is low; after a weaker one, a tip alone. The tip is the grader's note when the note is about the
 * weakest score (which it most likely is) and is no praise, else the pet's own line. Null when there is nothing to say.
 * A rubric 2 grade is weighed by its measures, and `hostileAt` is the tone that gets the gentle line.
 */
export const sayAbout = (
  graded: Graded,
  lines: Lines,
  avoid: Said['topic'] | null,
  hostileAt: number = hostileToneAt,
): Spoken =>
  graded.rubric === 2 ? sayAboutMeasures(graded, lines, avoid, hostileAt) : sayAboutScores(graded, lines, avoid)

/** Rubric 1's: the scores, regret upside down and grammar weighed kinder. */
const sayAboutScores = (
  graded: Extract<Graded, { scores: unknown }>,
  lines: Lines,
  avoid: Said['topic'] | null,
): Spoken => {
  const good = isGood(graded.grade)
  const weakest = weakestOf(graded.scores)
  const low = weakest.filter((one) => one !== avoid && (!good || weaknessOf(graded.scores, one) <= tipAt))
  const tip = low[0] ?? null
  const praise = good ? (strongestOf(graded.scores).find((one) => one !== avoid) ?? null) : null
  let said = lines
  const advice = (dimension: GradeDimension): string => {
    if (graded.note !== null && !isPraise(graded.note) && dimension === weakest[0]) return graded.note
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

/**
 * Rubric 2's: the content measures the prompt needed, never its craft or tone. A hostile tone (`hostileAt` or lower)
 * gets the gentle line in praise's place, its topic `tone`, unless the last bubble was about that; such a prompt is
 * capped below good, so it shows only when asked or with the coach set to always.
 */
const sayAboutMeasures = (
  graded: Extract<Graded, { rubric: 2 }>,
  lines: Lines,
  avoid: Said['topic'] | null,
  hostileAt: number,
): Spoken => {
  const { measures } = graded
  const good = isGood(graded.grade, 2)
  const weakest = weakestScoredOf(measures)
  const tip = weakest.find((one) => one.measure !== avoid && (!good || one.score <= tipAt))?.measure ?? null
  const isHostile = measures.tone !== null && measures.tone <= hostileAt && avoid !== 'tone'
  const praise = good && !isHostile ? (strongestMeasuresOf(measures).find((one) => one !== avoid) ?? null) : null
  let said = lines
  const say = (key: string, options: ReadonlyArray<string>): string => {
    const next = nextLine(said, key, options)
    said = next.lines
    return next.line
  }
  const advice = (measure: ContentMeasure): string =>
    graded.note !== null && !isPraise(graded.note) && measure === weakest[0]?.measure
      ? graded.note
      : say(`tip:${measure}`, measureTips[measure])
  const opening = isHostile
    ? [say('gentle:tone', gentle)]
    : praise === null
      ? []
      : [say(`praise:${praise}`, measurePraises[praise])]
  const out = [...opening, ...(tip === null ? [] : [advice(tip)])]
  const topic: Said['topic'] | null = isHostile ? 'tone' : (tip ?? praise)
  return { said: topic === null || out.length === 0 ? null : { lines: out, topic }, lines: said }
}

/** The prompt just graded, as the coach keeps it: its grade is the scores' mean until the server's arrives. */
export const gradedOf = (id: string, scores: Scores, note: string | null): Graded => ({
  rubric: 1,
  id,
  scores,
  note,
  grade: meanOf(scores),
  said: null,
})

/**
 * A prompt just graded by rubric 2, as the coach keeps it: its grade is the plain mean of the content measures it
 * needed until the server's arrives.
 */
export const gradedByMeasuresOf = (id: string, measures: MeasureScores, note: string | null): Graded => ({
  rubric: 2,
  id,
  measures,
  note,
  grade: measuresMeanOf(measures),
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
 * The rubric of the prompt whose XP a batch of the stream brings, by the coach's memory of it; `otherwise`, the rubric
 * the mod grades with now, for one it doesn't remember (graded in another session, say) or for none.
 */
export const heardRubricOf = (
  memory: CoachMemory | null,
  events: ReadonlyArray<ServerEvent>,
  otherwise: Rubric,
): Rubric => {
  const heard = heardOf(events)
  const last = memory?.last ?? null
  return heard !== null && last !== null && last.id === heard.id ? rubricOfGraded(last) : otherwise
}

/** What the pet is about to say unasked about a prompt, and the lines it says, kept once the bubble shows. */
export type Saying = { id: string; said: Said; lines: Readonly<Record<string, number>> }

/**
 * The server graded the prompt: the memory with its grade, and what the pet would say unasked about it, if anything.
 * Only about the last prompt graded, while the pet is on the band to say it (`onBand`), as the `coach` option allows,
 * at most once in `everyGraded` graded prompts, and not about the last bubble's score. A prompt the player already
 * asked about gets no bubble of its own. Nothing counts as said until the bubble shows (`spoke`).
 */
export const unasked = (
  memory: CoachMemory,
  heard: { id: string; grade: number },
  coach: Coach,
  onBand: boolean,
  hostileAt: number = hostileToneAt,
): { memory: CoachMemory; saying: Saying | null } => {
  const { last } = memory
  if (last === null || last.id !== heard.id) return { memory, saying: null }
  const graded: Graded = { ...last, grade: heard.grade }
  const kept: CoachMemory = { ...memory, last: graded }
  const isQuiet = memory.sinceBubble !== null && memory.sinceBubble < everyGraded
  const isAllowed = coach === 'always' || (coach === 'good' && isGood(heard.grade, rubricOfGraded(last)))
  if (!onBand || !isAllowed || isQuiet || last.said !== null) return { memory: kept, saying: null }
  const { said, lines } = sayAbout(graded, memory.lines, memory.lastTopic, hostileAt)
  return { memory: kept, saying: said === null ? null : { id: heard.id, said, lines } }
}

/** The bubble showed: what it said is the prompt's, the next unasked one waits 3 graded prompts, on another score. */
export const spoke = (memory: CoachMemory, saying: Saying): CoachMemory => ({
  ...memory,
  last: memory.last?.id === saying.id ? { ...memory.last, said: saying.said } : memory.last,
  lines: saying.lines,
  sinceBubble: 0,
  lastTopic: saying.said.topic,
})

/** `/pathofdev pet tip`: what the pet says about the last graded prompt, weak or not; the same when asked again. */
export const asked = (
  memory: CoachMemory,
  hostileAt: number = hostileToneAt,
): { memory: CoachMemory; said: Said | null } => {
  const { last } = memory
  if (last === null) return { memory, said: null }
  if (last.said !== null) return { memory, said: last.said }
  const { said, lines } = sayAbout(last, memory.lines, null, hostileAt)
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

/** The bubble beside the pet, in `cells` at most: the line in quotes, cut to fit; null when the band has no room. */
export const bubbleRow = (text: string, cells: number): Row | null =>
  cells < minBubble ? null : [{ text: '“', dim: true }, { text: cutAtWord(text, cells - 2) }, { text: '”', dim: true }]

/** Whether every line of what the pet says shows whole in a bubble of `cells`. */
export const fitsWhole = (said: Said, name: string, cells: number): boolean =>
  cells >= minBubble && said.lines.every((line) => cellsOf(named(line, name)) + 2 <= cells)
