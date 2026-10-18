import { describe, expect, test } from 'claude-code/testing'
import type { GradeDimension } from '@pathofdev/schema'
import type { CoachMemory, Graded } from '../types'
import { cellsOfRow } from './cells'
import {
  asked,
  bubbleRow,
  coachOf,
  fitsWhole,
  freshCoach,
  gradedOf,
  heardOf,
  isPraise,
  minBubble,
  phasesOf,
  remembered,
  sayAbout,
  spoke,
  tipText,
  unasked,
  weakestOf,
} from './coach'
import { noteMax, noteOf, RUBRIC } from './grade'

// The pet coach as plain values: which score it picks, the lines it says by turns, when it speaks unasked, the note
// read back from Haiku, and the bubble cut to the band.

type Scores = Record<GradeDimension, number>

const scores = (more: Partial<Scores> = {}): Scores => ({
  clarity: 8,
  grammar: 8,
  specificity: 8,
  instructive: 8,
  context: 8,
  doneCriteria: 8,
  focus: 8,
  regret: 0,
  ...more,
})

const graded = (more: Partial<Scores> = {}, grade = 8, note: string | null = null, id = 'p1'): Graded => ({
  ...gradedOf(id, scores(more), note),
  grade,
})

/** The memory with `graded` as its last prompt. */
const knowing = (last: Graded, more: Partial<CoachMemory> = {}): CoachMemory => ({ ...freshCoach, last, ...more })

describe('the weakest score', () => {
  test('is the lowest, regret upside down, and grammar only when it is very low', () => {
    expect(weakestOf(scores({ context: 3 }))[0]).toBe('context')
    // A lot of regret is the weak one; a little is none.
    expect(weakestOf(scores({ regret: 7 }))[0]).toBe('regret')
    expect(weakestOf(scores({ regret: 2 }))[0]).not.toBe('regret')
    // Grammar weighs 3 kinder: a 5 loses to a 7 elsewhere, a 2 doesn't.
    expect(weakestOf(scores({ grammar: 5, focus: 7 }))[0]).toBe('focus')
    expect(weakestOf(scores({ grammar: 2, focus: 7 }))[0]).toBe('grammar')
    // A tie goes to the score prompts most often lack: what done looks like.
    expect(weakestOf(scores({ doneCriteria: 4, clarity: 4 }))[0]).toBe('doneCriteria')
  })
})

describe('what the pet says', () => {
  test('after a good prompt: praise for its strongest score, and a tip for a low one; praise alone if none is', () => {
    const { said } = sayAbout(graded({ specificity: 10, doneCriteria: 4 }), {}, null)
    expect(said?.topic).toBe('doneCriteria')
    expect(said?.lines.map((line) => line.replace('{name}', 'Hoot'))).toEqual([
      'Hoot loves that you named the exact spot!',
      "Hoot wonders how you'll know it's done: a passing test? a behaviour?",
    ])
    const alone = sayAbout(graded({ focus: 10 }), {}, null).said
    expect(alone?.lines.map((line) => line.replace('{name}', 'Hoot'))).toEqual(['Nice and focused, Hoot says!'])
    expect(alone?.topic).toBe('focus')
  })

  test('after a weaker prompt: a tip alone, never praise', () => {
    const { said } = sayAbout(graded({ context: 2, clarity: 5 }, 5.5), {}, null)
    expect(said?.lines).toEqual(['{name} wonders why: a line of why helps Claude choose.'])
  })

  test("prefers the grader's note for the weakest score, and its own line when that score is to be avoided", () => {
    const note = 'Say which test should pass.'
    expect(sayAbout(graded({ doneCriteria: 3 }, 5, note), {}, null).said?.lines).toEqual([note])
    const avoided = sayAbout(graded({ doneCriteria: 3, focus: 4 }, 5, note), {}, 'doneCriteria').said
    expect(avoided?.topic).toBe('focus')
    expect(avoided?.lines).toEqual(['{name} suggests one ask at a time; the rest can wait.'])
  })

  test("a note that praises is no tip: the pet's own line stands in for it", () => {
    for (const note of ['Great, clear prompt!', 'Nothing to improve here.', 'Clear and well scoped.']) {
      expect(isPraise(note)).toBe(true)
      expect(sayAbout(graded({ doneCriteria: 3 }, 5, note), {}, null).said?.lines).toEqual([
        "{name} wonders how you'll know it's done: a passing test? a behaviour?",
      ])
    }
    expect(isPraise('Say which test should pass.')).toBe(false)
  })

  test('says its lines for a score by turns, never the same one twice in a row', () => {
    let lines = {}
    const said: Array<string> = []
    for (let round = 0; round < 7; round++) {
      const next = sayAbout(graded({ specificity: 3 }, 5), lines, null)
      lines = next.lines
      said.push(next.said?.lines[0] ?? '')
    }
    expect(new Set(said).size).toBe(3)
    for (let i = 1; i < said.length; i++) expect(said[i]).not.toBe(said[i - 1])
  })

  test('the name goes into each line; praise stands 3 s and the tip 5, a line alone the whole 8', () => {
    const { said } = sayAbout(graded({ specificity: 10, doneCriteria: 4 }), {}, null)
    if (said === null) throw new Error('nothing said')
    expect(phasesOf(said, 'Ember').map((one) => one.ms)).toEqual([3_000, 5_000])
    expect(phasesOf(said, 'Ember')[0]?.text).toBe('Ember loves that you named the exact spot!')
    expect(phasesOf({ lines: ['{name} likes it.'], topic: 'focus' }, 'Ember')).toEqual([
      { text: 'Ember likes it.', ms: 8_000 },
    ])
    expect(tipText(said, 'Ember')).toMatch(/^Ember loves that you named the exact spot! Ember wonders how/)
  })
})

describe('when it speaks unasked', () => {
  const heard = { id: 'p1', grade: 8 }

  test('after a good prompt, as the coach option allows; after a weak one only when it says always', () => {
    const memory = knowing(graded({ doneCriteria: 4 }, 8))
    expect(unasked(memory, heard, 'good', true).saying).not.toBeNull()
    expect(unasked(memory, heard, 'always', true).saying).not.toBeNull()
    expect(unasked(memory, heard, 'off', true).saying).toBeNull()
    const weak = { id: 'p1', grade: 4.2 }
    expect(unasked(memory, weak, 'good', true).saying).toBeNull()
    expect(unasked(memory, weak, 'always', true).saying?.said.lines).toHaveLength(1)
  })

  test("at most once in 3 graded prompts, never about the last bubble's score again", () => {
    let memory = freshCoach
    const topics: Array<GradeDimension | null> = []
    for (let round = 1; round <= 7; round++) {
      const id = `p${round}`
      memory = remembered(memory, gradedOf(id, scores({ doneCriteria: 4, specificity: 5 }), null))
      const next = unasked(memory, { id, grade: 8 }, 'good', true)
      // Each bubble shows: only a shown one counts.
      memory = next.saying === null ? next.memory : spoke(next.memory, next.saying)
      topics.push(next.saying?.said.topic ?? null)
    }
    expect(topics).toEqual(['doneCriteria', null, null, 'specificity', null, null, 'doneCriteria'])
  })

  test('a bubble that never showed counts for nothing: the next good prompt may still speak', () => {
    let memory = remembered(freshCoach, gradedOf('p1', scores({ doneCriteria: 4 }), null))
    const first = unasked(memory, { id: 'p1', grade: 8 }, 'good', true)
    expect(first.saying).not.toBeNull()
    // Hushed before it showed: `spoke` never ran.
    memory = remembered(first.memory, gradedOf('p2', scores({ doneCriteria: 4 }), null))
    expect(unasked(memory, { id: 'p2', grade: 8 }, 'good', true).saying?.said.topic).toBe('doneCriteria')
    expect(first.memory.last?.said).toBeNull()
  })

  test('only about the last prompt graded, with the pet on the band, and not once the player asked', () => {
    const memory = knowing(graded({ doneCriteria: 4 }, 8, null, 'p2'))
    expect(unasked(memory, heard, 'good', true)).toEqual({ memory, saying: null })
    const later = { id: 'p2', grade: 8 }
    // Off the band, or still an egg: nothing said, and nothing counted against the next.
    const hidden = unasked(memory, later, 'good', false)
    expect(hidden.saying).toBeNull()
    expect(hidden.memory.sinceBubble).toBeNull()
    expect(unasked(asked(memory).memory, later, 'good', true).saying).toBeNull()
  })

  test("takes the server's grade for the prompt: it decides between praise and a tip alone", () => {
    const memory = knowing(graded({ doneCriteria: 4 }, 7.2))
    expect(unasked(memory, { id: 'p1', grade: 6.4 }, 'always', true).memory.last?.grade).toBe(6.4)
    expect(unasked(memory, { id: 'p1', grade: 6.4 }, 'always', true).saying?.said.lines).toHaveLength(1)
  })

  test('the XP a graded prompt earned names the prompt by its cause; other XP is none', () => {
    const grant = (reason: string, cause: string | null) =>
      ({
        seq: 1,
        at: '2026-10-09T08:00:00.000Z',
        cause,
        type: 'xp.granted',
        data: { amount: 12, tier: 'reported', reason, totalAfter: 150, grade: 7.5 },
      }) satisfies Parameters<typeof heardOf>[0][number]
    expect(heardOf([grant('prompt.graded', 'p1')])).toEqual({ id: 'p1', grade: 7.5 })
    expect(heardOf([grant('commit.made', 'p1')])).toBeNull()
    expect(heardOf([grant('prompt.graded', null)])).toBeNull()
  })
})

describe('/pathofdev pet tip', () => {
  test('says the last prompt’s tip, weak or not, and the same again when asked again', () => {
    const memory = knowing(graded({ context: 2 }, 3.5))
    const first = asked(memory)
    expect(first.said?.lines).toEqual(['{name} wonders why: a line of why helps Claude choose.'])
    expect(asked(first.memory).said).toEqual(first.said)
    expect(asked(freshCoach).said).toBeNull()
  })
})

describe("the grader's note", () => {
  const reply = (note: unknown) => `${JSON.stringify({ ...scores(), note })}\n`

  test('asks for one concrete thing in at most 12 words, and the scores mean what they meant', () => {
    expect(RUBRIC).toContain('the one concrete thing that would have made this prompt better')
    expect(RUBRIC).toContain('most 12 words')
    expect(RUBRIC).not.toContain('at most 8 words')
  })

  test('reads back trimmed, on one line, its quotes and control characters gone', () => {
    expect(noteOf(reply('  Say which test should pass.  '))).toBe('Say which test should pass.')
    expect(noteOf(reply('"Name the\nfailing\ttest."'))).toBe('Name the failing test.')
    expect(noteOf(reply('Name the file\u0007 and the error \u{1F600}'))).toBe('Name the file and the error')
    // Flags, skin tones and keycaps too, which the band can't count the cells of.
    expect(noteOf(reply('Ship it \u{1F1FA}\u{1F1F8} once 1\u{20E3} test \u{1F44D}\u{1F3FD} passes'))).toBe(
      'Ship it once 1 test passes',
    )
  })

  test('is cut at a word past its longest', () => {
    const long = noteOf(
      reply('Point at the parser file and say which of the failing tests should pass once it is done, and what stays'),
    )
    expect(long?.length).toBeLessThanOrEqual(noteMax)
    expect(long).toMatch(/^Point at the parser file .*[a-z]…$/)
  })

  test('is dropped when missing, empty or junk', () => {
    const junk = [undefined, 42, '', '   ', 'ok', '{"x":1}', 'see https://example.com now', 'at most 12 words', '...']
    for (const one of junk) expect(noteOf(reply(one))).toBeNull()
    expect(noteOf('no json here')).toBeNull()
  })
})

describe('the bubble', () => {
  test('fits the room it is given, cut at a word, or is none below the least', () => {
    const text = 'Ember wonders how you will know it is done: a passing test?'
    for (let cells = minBubble; cells <= 70; cells++) {
      const row = bubbleRow(text, cells)
      expect(row).not.toBeNull()
      expect(cellsOfRow(row ?? [])).toBeLessThanOrEqual(cells)
    }
    expect(bubbleRow(text, 70)?.map((run) => run.text).join('')).toBe(`“${text}”`)
    expect(bubbleRow(text, 30)?.map((run) => run.text).join('')).toBe('“Ember wonders how you will…”')
    expect(bubbleRow(text, minBubble - 1)).toBeNull()
  })

  test('says whether every line shows whole', () => {
    const said = { lines: ['{name} likes it.', 'Say which test should pass.'], topic: 'focus' } satisfies {
      lines: Array<string>
      topic: GradeDimension
    }
    expect(fitsWhole(said, 'Ember', 29)).toBe(true)
    expect(fitsWhole(said, 'Ember', 28)).toBe(false)
  })

  test('the coach option reads good, always or off, and anything else as good', () => {
    expect(coachOf({})).toBe('good')
    expect(coachOf({ coach: 'always' })).toBe('always')
    expect(coachOf({ coach: 'off' })).toBe('off')
    expect(coachOf({ coach: 'loud' })).toBe('good')
  })
})
