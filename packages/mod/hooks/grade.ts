import type { GradeDimension, GradedV2, PromptKind, RulesConfig } from '@pathofdev/schema'
import type { PluginOptions } from 'claude-code'
import { cutAtWord } from './cells'
import { isRecord } from './server'

// Grading the prompts the player types: which ones are graded, what Haiku is asked, and reading its scores back.
// Only the scores leave the machine; the prompt, the answer it follows, the grader's note and the words it found
// misspelled stay here.

/**
 * A rubric, as the server's `prompt.rubricVersion` names it. A change to what the scores mean makes a new one; the
 * note's wording, which never leaves the machine, doesn't.
 */
export type Rubric = 1 | 2

/**
 * The rubric to grade with: 2 against a server whose rules carry `prompt.v2`, which only one that prices it sends,
 * else 1, which every server takes.
 */
export const rubricOf = (rules: Partial<RulesConfig>): Rubric => (isRecord(rules.prompt?.v2) ? 2 : 1)

/** The rubric the store keeps for a server, as its last rules said: 2 only when it says so, else 1. */
export const storedRubricOf = (stored: unknown): Rubric => (stored === 2 ? 2 : 1)

/** Rubric 1: seven quality scores and a regret. */
export const RUBRIC = `You grade one prompt a developer typed to an AI coding assistant. Score each from 0 to 10 against what
this prompt needs, not against an ideal task prompt: a short follow-up or a question loses nothing for context it does not need.
clarity: the ask is unambiguous and easy to follow
grammar: spelling, grammar and punctuation
specificity: points at the files, errors, symbols or examples involved
instructive: concrete, actionable direction (what, where, constraints)
context: gives the why behind the ask
doneCriteria: says how to know it is finished (tests pass, a behaviour, a shape)
focus: one well-sized ask rather than a sprawling list
regret: how much it walks back or corrects earlier work or instructions (0 none, 10 undo everything)
note: the one concrete thing that would have made this prompt better, as a friendly suggestion to the developer in at
most 12 words, such as "Say which test should pass when it's done."; brief praise if nothing would
Reply with strict JSON only, no prose and no code fence:
{"clarity":n,"grammar":n,"specificity":n,"instructive":n,"context":n,"doneCriteria":n,"focus":n,"regret":n,"note":"..."}`

/**
 * Rubric 2: what kind of prompt it is, the measures against what it needs at this point in the conversation, and the
 * words it misspells, which `spelledCleanOf` checks against the prompt.
 */
export const RUBRIC_V2 = `
You grade one prompt a developer typed to an AI coding assistant. Read the previous prompt and the end of the
assistant's previous answer first, then judge the prompt against what THIS prompt needs at this point in the
conversation, not against an ideal task prompt. A short reply to a question the assistant just asked can be excellent.
kind: task (change, build, fix or run something), question (wants an answer or an explanation), discussion (thinks
aloud, weighs options, asks for an opinion or a design), or steer (a short reply that approves, answers, corrects or
redirects the assistant's last message)
Score each measure from 0 to 10. Scale: 1 missing or misleading; 3 vague, the assistant must guess; 5 workable but
missing something it needs; 7 a clear, solid everyday prompt; 9 exceptional, nothing to add.
A measure is never low just because this prompt doesn't need it: a steer needs no file names, a discussion needs no
test to pass. When the prompt gives all that it needs on a measure, score it 7 or more. For why and successShape,
give null rather than a low score when the prompt doesn't need them; score them low only when it needs them and lacks
them.
intent: it is clear what the developer wants back: an action, an answer, a decision or an opinion
grounding: it points at what it is about (files, errors, symbols, an earlier message, the last answer) well enough to
find it; a follow-up that clearly refers to the conversation is well grounded
why: it shares reasons, constraints or observations that help judgement calls; null when none are needed, as in "go ahead"
successShape: it says what a good outcome looks like: for a task, how to know it is done; for a question or a
discussion, what a good answer should do, and naming what the answer should weigh or produce (a recommendation,
options, a revised design) is enough for 7; null when the conversation already makes it plain
scope: one well-sized ask, not a sprawl of unrelated asks or a self-contradiction
forward: it moves the work forward by adding something new: a decision, new information, a correction, a method; a
self-contradiction, or three or more unrelated asks, adds confusion, not progress: score forward 3 or below. A main
ask with a side thought still moves the work forward
craft: grammar, composition and apt vocabulary only; ignore spelling entirely, so a well-composed prompt can score
high despite misspellings. 6 is plain or loose: loose grammar costs nothing below 6. Above 6 only for well-formed,
well-composed sentences; apt, rich vocabulary used correctly in context earns 9 or 10. Judge the writing, not its topic
misspelled: the ordinary words that are misspelled, each copied exactly as typed, at most 8, [] when none; code
identifiers, file paths, commands, product names, URLs, jargon, and deliberate slang or emoticons such as ":P" don't
count
tone: 5 neutral; 6 to 10 kind, courteous or appreciative; 3 or 4 rough or curt; 0 to 2 cursing, insults or hostility
toward the assistant
note: the one concrete thing that would have made this prompt better, as a friendly suggestion to the developer in at
most 12 words, such as "Say which test should pass when it's done."; brief praise if nothing would
Reply with strict JSON only, no prose and no code fence:
{"kind":"...","intent":n,"grounding":n,"why":n or null,"successShape":n or null,"scope":n,"forward":n,"craft":n,"misspelled":["..."],"tone":n,"note":"..."}`.trimStart()

export const rubrics: Record<Rubric, string> = { 1: RUBRIC, 2: RUBRIC_V2 }

/**
 * The most a reply may take, its thinking included. A rubric 2 reply runs to about 120 tokens, and a full list of
 * misspellings 40 more, but Haiku thinks first on about one reply in seven, the rambling and the rude ones most: up to
 * about 1000 tokens in the grading experiment. A cut reply doesn't parse and the prompt goes ungraded, and only what
 * is produced is billed, so the cap leaves twice that.
 */
export const maxTokens = 2048

/** How much of the previous answer the grader reads: its end, where the question to the player usually is. */
export const answerTail = 1500

const defaultMinWords = 6

/** The `minWords` option: a prompt shorter than this goes ungraded. A value that is no whole number above 0 is 6. */
export const minWordsOf = (options: PluginOptions): number => {
  const value = options['minWords']
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : defaultMinWords
}

export const wordsOf = (text: string): number => text.split(/\s+/).filter((word) => word !== '').length

/** A slash command's name opens the text: `/compact`, `/plugin:name`, never a path such as `/src/parser.ts`. */
export const isSlashCommand = (text: string): boolean => /^\/[A-Za-z0-9][A-Za-z0-9:._-]*(?:\s|$)/.test(text.trimStart())

/** Typed at the prompt box, not a slash command, and long enough. Pasted text counts toward the words. */
export const isGradable = (originKind: string, text: string, words: number, minWords: number): boolean =>
  originKind === 'composer' && !isSlashCommand(text) && words >= minWords

/** What the grader is asked: the prompt, with the one before it and the end of the answer between them. */
export const askFor = (text: string, previous: string, answer: string): string =>
  [
    `Previous prompt by the user:\n${previous === '' ? '(none)' : previous}`,
    `End of the assistant's previous answer:\n${answer === '' ? '(none)' : answer}`,
    `The prompt to grade:\n<prompt>\n${text}\n</prompt>`,
  ].join('\n\n')

const fieldsOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null

/** A score in range, rounded to the whole number the server takes; null for anything else. */
const scoreOf = (value: unknown): number | null =>
  typeof value === 'number' && value >= 0 && value <= 10 ? Math.round(value) : null

const isComplete = (scores: Record<GradeDimension, number | null>): scores is Record<GradeDimension, number> =>
  Object.values(scores).every((score) => score !== null)

const parsedOf = (json: string): Record<string, unknown> | null => {
  try {
    return fieldsOf(JSON.parse(json))
  } catch {
    return null
  }
}

/**
 * The fields of the reply's {...}, its first `{` to its last `}`; null when it doesn't parse as an object. Haiku now
 * and then leaves a stray `","` before the closing brace (`…"note":"…","}`): only a reply that fails to parse is tried
 * once more without it, so a note that ends in a comma (`"note":"…,"}`) is never touched.
 */
const replyFieldsOf = (reply: string): Record<string, unknown> | null => {
  const json = /\{[\s\S]*\}/.exec(reply)?.[0]
  if (json === undefined) return null
  return parsedOf(json) ?? parsedOf(json.replace(/,\s*"\s*\}$/, '}'))
}

/** The scores in the reply's {...}; null when it doesn't parse or any score is missing or out of range. */
export const scoresOf = (reply: string): Record<GradeDimension, number> | null => {
  const fields = replyFieldsOf(reply)
  if (fields === null) return null
  const scores: Record<GradeDimension, number | null> = {
    clarity: scoreOf(fields['clarity']),
    grammar: scoreOf(fields['grammar']),
    specificity: scoreOf(fields['specificity']),
    instructive: scoreOf(fields['instructive']),
    context: scoreOf(fields['context']),
    doneCriteria: scoreOf(fields['doneCriteria']),
    focus: scoreOf(fields['focus']),
    regret: scoreOf(fields['regret']),
  }
  return isComplete(scores) ? scores : null
}

/** The eight measures of a rubric 2 grade, as the event carries them. */
export type Measures = GradedV2['measures']

const kinds: ReadonlyArray<PromptKind> = ['task', 'question', 'discussion', 'steer']

const kindOf = (value: unknown): PromptKind | null => kinds.find((kind) => kind === value) ?? null

/** A measure that may be null: null as given, else a score; undefined when it is missing or out of range. */
const nullableOf = (value: unknown): number | null | undefined =>
  value === null ? null : (scoreOf(value) ?? undefined)

/**
 * The kind and the measures in the reply's {...}; null when it doesn't parse, the kind is none of the four, or a
 * measure is missing or out of range. `why` and `successShape` may be null, but not missing. A kind is never guessed:
 * a steer read as a task would grade past the steer's cap.
 */
export const measuresOf = (reply: string): { kind: PromptKind; measures: Measures } | null => {
  const fields = replyFieldsOf(reply)
  if (fields === null) return null
  const kind = kindOf(fields['kind'])
  const intent = scoreOf(fields['intent'])
  const grounding = scoreOf(fields['grounding'])
  const why = nullableOf(fields['why'])
  const successShape = nullableOf(fields['successShape'])
  const scope = scoreOf(fields['scope'])
  const forward = scoreOf(fields['forward'])
  const craft = scoreOf(fields['craft'])
  const tone = scoreOf(fields['tone'])
  if (kind === null || why === undefined || successShape === undefined) return null
  if (intent === null || grounding === null || scope === null || forward === null || craft === null || tone === null)
    return null
  return { kind, measures: { intent, grounding, why, successShape, scope, forward, craft, tone } }
}

/** The most words of the grader's list the mod checks. */
export const maxMisspelled = 8
const maxWordLength = 40

/** One word of 1 to 40 characters, with a letter in it. */
const isWord = (entry: string): boolean => {
  const length = [...entry].length
  return length >= 1 && length <= maxWordLength && !/\s/u.test(entry) && /\p{L}/u.test(entry)
}

const escaped = (word: string): string => word.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/**
 * Whether `word` stands in `text` as a whole word, any case: `cat` never in `concatenate`, nor `don` in `don't` or
 * `don’t`. An apostrophe joins a word only between letters, so a word in single quotes (`'recieve'`) stands whole.
 */
const isWholeWordIn = (word: string, text: string): boolean =>
  new RegExp(
    `(?<![\\p{L}\\p{N}_])(?<![\\p{L}\\p{N}]['’])${escaped(word)}(?![\\p{L}\\p{N}_])(?!['’][\\p{L}\\p{N}])`,
    'iu',
  ).test(text)

/**
 * Whether the prompt is spelled clean, by the reply's `misspelled` list: true when no word on it (one word each, the
 * first 8) stands in the prompt as typed, so a word the grader made up never costs the bonus. Anything but a list of
 * strings is false: no bonus, though the grade still counts. The list itself never leaves this function.
 */
export const spelledCleanOf = (reply: string, prompt: string): boolean => {
  const listed: unknown = replyFieldsOf(reply)?.['misspelled']
  if (!Array.isArray(listed)) return false
  const entries: ReadonlyArray<unknown> = listed
  const words = entries.filter((entry): entry is string => typeof entry === 'string')
  if (words.length !== entries.length) return false
  const text = prompt.normalize('NFC')
  const checked = [...new Set(words.map((word) => word.trim().normalize('NFC')).filter(isWord))].slice(0, maxMisspelled)
  return !checked.some((word) => isWholeWordIn(word, text))
}

/** The longest note the pet says, in cells: twelve words and some slack. A longer one is cut at a word. */
export const noteMax = 90

// Controls, invisible and direction marks, line and paragraph breaks, and emoji with their flags, skin tones and
// keycaps, which would break the band's cells.
const unsafe = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu
const emoji = /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u{FE0F}\u{20E3}]/gu
const quotes = /^["'`\u2018\u2019\u201C\u201D]+|["'`\u2018\u2019\u201C\u201D]+$/g

/**
 * The grader's note in the reply, as the pet may say it: one line, trimmed, its quotes and anything that would break
 * the band taken out, cut at a word past `noteMax`. Null when there is none or it is junk: no two words of letters,
 * markup or code, a link, or the rubric's own words read back. It stays on this machine.
 */
export const noteOf = (reply: string): string | null => {
  const raw = replyFieldsOf(reply)?.['note']
  if (typeof raw !== 'string') return null
  const line = raw.replace(unsafe, ' ').replace(emoji, ' ').replace(/\s+/g, ' ').trim().replace(quotes, '').trim()
  const words = line.split(' ').filter((word) => /\p{L}/u.test(word))
  const isJunk = /[{}<>\\|`]|https?:|www\./i.test(line) || /\b(12|twelve) words\b|^note\b/i.test(line)
  if (words.length < 2 || isJunk) return null
  return cutAtWord(line, noteMax)
}
