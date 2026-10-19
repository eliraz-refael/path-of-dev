import { it as prop } from '@effect/vitest'
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { maxMisspelled, measuresOf, noteOf, scoresOf, spelledCleanOf } from '../hooks/grade'
import controlsJson from './fixtures/controls.json'

// Reading Haiku's reply to rubric 2, as properties: the readers take any text without throwing, a whole reply reads
// back as it was written, the stray `","` before the brace is repaired only when the reply fails to parse, and a word
// on the misspelled list costs the bonus only when it stands in the prompt as a whole word.

const Score = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 }))
const Kind = Schema.Literals(['task', 'question', 'discussion', 'steer'])
const Word = Schema.String.check(Schema.isPattern(/^[A-Za-z]{1,8}$/))
const Note = Schema.Union([Schema.String, Schema.Literals(['Say which test should pass,', 'Name the file, "}', ', "', 'ok'])])

const Reply = Schema.Struct({
  kind: Kind,
  intent: Score,
  grounding: Score,
  why: Schema.NullOr(Score),
  successShape: Schema.NullOr(Score),
  scope: Score,
  forward: Score,
  craft: Score,
  misspelled: Schema.Array(Word).check(Schema.isMaxLength(maxMisspelled)),
  tone: Score,
  note: Note,
})
type Reply = typeof Reply.Type

const measuresIn = (reply: Reply) => ({
  kind: reply.kind,
  measures: {
    intent: reply.intent,
    grounding: reply.grounding,
    why: reply.why,
    successShape: reply.successShape,
    scope: reply.scope,
    forward: reply.forward,
    craft: reply.craft,
    tone: reply.tone,
  },
})

/** A reply with the stray `","` before its closing brace, as Haiku now and then writes one. */
const strayed = (json: string): string => json.replace(/\}$/, ',"}')

/** A prompt of `words`, each after one of the separators, in turn. */
const Separator = Schema.Literals([' ', ', ', '. ', '\n', '-', ' (', ') '])
const Prompt = Schema.Array(Schema.Struct({ word: Word, after: Separator })).check(Schema.isMaxLength(20))
const promptOf = (parts: typeof Prompt.Type): string => parts.map((part) => `${part.after}${part.word}`).join('')

/** The words of a prompt made of letters and separators, by their lower case: the whole words a list can name. */
const wordsIn = (prompt: string): Set<string> =>
  new Set(prompt.split(/[^A-Za-z]+/).filter((word) => word !== '').map((word) => word.toLowerCase()))

const replyListing = (misspelled: unknown): string =>
  JSON.stringify({ kind: 'task', intent: 7, grounding: 7, why: null, successShape: 7, scope: 7, forward: 7, craft: 6, misspelled, tone: 5, note: 'ok' })

describe('reading a rubric 2 reply', () => {
  prop.prop('takes any text without throwing: a kind of the four and scores 0-10, or nothing', [Schema.String], ([text]) => {
    const read = measuresOf(text)
    if (read === null) return
    expect(['task', 'question', 'discussion', 'steer']).toContain(read.kind)
    for (const score of Object.values(read.measures)) {
      if (score !== null) expect(Number.isInteger(score) && score >= 0 && score <= 10).toBe(true)
    }
    expect(typeof spelledCleanOf(text, text)).toBe('boolean')
  })

  prop.prop('takes any reply and any prompt, and says yes or no', [Schema.String, Schema.String], ([reply, prompt]) => {
    expect(typeof spelledCleanOf(reply, prompt)).toBe('boolean')
  })

  prop.prop('reads a whole reply back as written, its nulls kept', [Reply], ([reply]) => {
    expect(measuresOf(JSON.stringify(reply))).toEqual(measuresIn(reply))
    expect(measuresOf(`Here it is:\n${JSON.stringify(reply)}\n`)).toEqual(measuresIn(reply))
  })

  prop.prop('repairs a stray "," before the closing brace, and only a reply that fails to parse', [Reply], ([reply]) => {
    const json = JSON.stringify(reply)
    expect(measuresOf(strayed(json))).toEqual(measuresIn(reply))
    expect(spelledCleanOf(strayed(json), 'a prompt')).toBe(spelledCleanOf(json, 'a prompt'))
    // A note that ends in a comma parses on the first try, untouched: the repair would have broken it.
    const comma = JSON.stringify({ ...reply, note: 'Say which test should pass,' })
    expect(comma.endsWith(',"}')).toBe(true)
    expect(measuresOf(comma)).toEqual(measuresIn(reply))
    expect(noteOf(comma)).toBe('Say which test should pass,')
  })

  prop.prop('a missing measure, or a kind of none of the four, reads as nothing', [Reply, Schema.Literals(['intent', 'why', 'successShape', 'craft', 'tone', 'kind'])], ([reply, left]) => {
    const fields: Record<string, unknown> = { ...reply }
    delete fields[left]
    expect(measuresOf(JSON.stringify(fields))).toBeNull()
    expect(measuresOf(JSON.stringify({ ...reply, kind: 'chat' }))).toBeNull()
  })
})

describe('the misspelled check', () => {
  prop.prop('costs the bonus only for a word on the list that stands whole in the prompt, in any case', [Prompt, Schema.Array(Word).check(Schema.isMaxLength(maxMisspelled))], ([parts, listed]) => {
    const prompt = promptOf(parts)
    const present = wordsIn(prompt)
    const isVerified = listed.some((word) => present.has(word.toLowerCase()))
    expect(spelledCleanOf(replyListing(listed), prompt)).toBe(!isVerified)
    expect(spelledCleanOf(replyListing(listed.map((word) => word.toUpperCase())), prompt.toLowerCase())).toBe(!isVerified)
  })

  prop.prop('a word the grader made up never costs it', [Prompt, Word], ([parts, word]) => {
    const prompt = promptOf(parts)
    const madeUp = `${word}qzx`
    if (!wordsIn(prompt).has(madeUp.toLowerCase())) expect(spelledCleanOf(replyListing([madeUp]), prompt)).toBe(true)
  })

  prop.prop('anything but a list of strings is no bonus', [Schema.Union([Schema.Number, Schema.String, Schema.Null, Schema.Array(Schema.Union([Schema.String, Schema.Number]))])], ([listed]) => {
    const isStrings = Array.isArray(listed) && listed.every((one) => typeof one === 'string')
    if (!isStrings) expect(spelledCleanOf(replyListing(listed), 'fix teh bug')).toBe(false)
  })

  prop.prop('reads the rubric 1 scores no differently for the repair', [Score, Score], ([clarity, focus]) => {
    const scores = { clarity, grammar: 7, specificity: 7, instructive: 7, context: 7, doneCriteria: 7, focus, regret: 0 }
    expect(scoresOf(strayed(JSON.stringify({ ...scores, note: 'ok' })))).toEqual(scores)
  })
})

describe('the misspelled check, by example', () => {
  const verified = (listed: unknown, prompt: string) => !spelledCleanOf(replyListing(listed), prompt)

  it('a word counts only whole: cat is not in concatenate, nor don in don’t', () => {
    expect(verified(['cat'], 'concatenate the lists')).toBe(false)
    expect(verified(['don'], "don't touch the API")).toBe(false)
    expect(verified(['cat'], 'the cat, sat')).toBe(true)
    expect(verified(['teh'], 'fix_teh_bug')).toBe(false)
  })

  it('review fix: a word in quotes stands whole, and a typed apostrophe joins a word as the plain one does', () => {
    expect(verified(['Submitt'], "the button says 'Submitt' now")).toBe(true)
    expect(verified(['recieve'], "'recieve' the payload")).toBe(true)
    expect(verified(['don'], 'don’t touch the API')).toBe(false)
    expect(verified(['t'], 'don’t touch the API')).toBe(false)
    expect(verified(['t'], "don't touch the API")).toBe(false)
  })

  it('ignores case, and compares both sides composed', () => {
    expect(verified(['Teh'], 'fix TEH bug')).toBe(true)
    expect(verified(['café'], 'the café menu')).toBe(true)
  })

  it('is clean on an empty list, and takes no more than 8 words, each one word with a letter in it', () => {
    expect(verified([], 'fix teh bug')).toBe(false)
    const others = ['aa', 'bb', 'cc', 'dd', 'ee', 'ff', 'gg', 'hh']
    expect(verified([...others, 'teh'], 'fix teh bug')).toBe(false)
    expect(verified(['teh bug', '123', '', 'x'.repeat(41)], 'fix teh bug 123')).toBe(false)
    expect(verified(['  teh '], 'fix teh bug')).toBe(true)
    // A word the regex would read as a pattern is read as itself.
    expect(verified(['t.h'], 'fix teh bug')).toBe(false)
    expect(verified(['(teh'], 'fix (teh bug')).toBe(true)
  })
})

// Haiku's own replies to the seven synthetic control prompts, five runs each, under the rubric 2 text as it ships: the
// replies the plan's grade ranges were checked on.
const Control = Schema.Struct({ name: Schema.String, prompt: Schema.String, replies: Schema.Array(Schema.String) })
const controls = Schema.decodeUnknownSync(Schema.Array(Control))(controlsJson)

describe("Haiku's replies to the controls", () => {
  it('all 35 read, one after the repair, and every control is spelled clean', () => {
    const replies = controls.flatMap((control) => control.replies.map((reply) => ({ reply, prompt: control.prompt })))
    expect(replies).toHaveLength(35)
    for (const { reply, prompt } of replies) {
      expect(measuresOf(reply), reply).not.toBeNull()
      expect(spelledCleanOf(reply, prompt), reply).toBe(true)
    }
    const repaired = replies.filter(({ reply }) => {
      try {
        JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1))
        return false
      } catch {
        return true
      }
    })
    expect(repaired).toHaveLength(1)
  })
})
