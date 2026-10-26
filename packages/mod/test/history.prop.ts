import { it as prop } from '@effect/vitest'
import { Schema } from 'effect'
import { describe, expect } from 'vitest'
import { countsOf, freshTally, lineReader, longestStreakOf, tallyLine } from '../hooks/history'

// What an import counts, as properties over the shapes transcripts come in: lines cut anywhere by a stream read back
// whole, the longest run of days as a plain walk counts it, only what is dated before the player started, and never
// a string of the transcripts' own in what the mod sends, whatever the prompts, folders and tools are called.

const between = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }))

const Line = Schema.String.check(Schema.makeFilter((text: string) => !text.includes('\n') || 'one line'))

const dayMs = 86_400_000
const base = Date.parse('2026-01-01T12:00:00Z')

describe('a stream of a transcript', () => {
  prop.prop(
    'reads back every line whole, however its pieces cut it',
    [Schema.Array(Line).check(Schema.isMaxLength(12)), Schema.Array(between(1, 9)).check(Schema.isMinLength(1))],
    ([lines, cuts]) => {
      const text = lines.join('\n')
      const read: Array<string> = []
      const reader = lineReader((line) => read.push(line))
      let at = 0
      for (let i = 0; at < text.length; i++) {
        const size = cuts[i % cuts.length] ?? 1
        reader.push(text.slice(at, at + size))
        at += size
      }
      reader.end()
      // A last empty line has no end to come, so it is no line.
      expect(read).toEqual(lines.length > 0 && lines.at(-1) === '' ? lines.slice(0, -1) : lines)
    },
  )
})

describe('the longest streak', () => {
  prop.prop('is the longest run of days in a row, as a walk over every day counts it', [Schema.Array(between(0, 60))], ([offsets]) => {
    const days = offsets.map((offset) => new Date(base + offset * dayMs).toISOString().slice(0, 10))
    const active = new Set(offsets)
    let best = 0
    for (let day = 0; day <= 60; day++) {
      let run = 0
      while (active.has(day + run)) run += 1
      best = Math.max(best, run)
    }
    expect(longestStreakOf(days)).toBe(best)
    expect(longestStreakOf(days)).toBeLessThanOrEqual(new Set(days).size)
  })
})

/** A prompt line, with the player's own words, folder and tool names in it. */
const Prompted = Schema.Struct({
  text: Schema.String,
  project: Schema.String,
  session: Schema.String,
  tool: Schema.String,
  command: Schema.String,
  /** Minutes from the player's start: negative is before it. */
  minutes: between(-200_000, 2_000),
})

const before = Date.parse('2026-10-09T08:00:00Z')

describe('the counts an import sends', () => {
  prop.prop(
    'count only what is dated before the player started, and hold no string of the transcripts but two days',
    [Schema.Array(Prompted).check(Schema.isMaxLength(20))],
    ([prompts]) => {
      const tally = freshTally(before, 'UTC')
      prompts.forEach((one, i) => {
        const timestamp = new Date(before + one.minutes * 60_000).toISOString()
        const message = { role: 'user', content: `typed: ${one.text}` }
        tallyLine(tally, JSON.stringify({ type: 'user', uuid: `u${i}`, timestamp, cwd: one.project, message }), one.project, one.session)
        const call = { type: 'tool_use', id: `t${i}`, name: one.tool, input: { command: one.command } }
        tallyLine(tally, JSON.stringify({ type: 'assistant', timestamp, message: { content: [call] } }), one.project, one.session)
      })
      const counts = countsOf(tally)
      const earlier = prompts.filter((one) => one.minutes < 0)
      expect(counts.prompts).toBe(earlier.length)
      expect(Object.values(counts.tools).reduce((sum, count) => sum + count, 0)).toBe(earlier.length)
      expect(counts.sessions).toBeLessThanOrEqual(counts.prompts)
      expect(counts.days).toBeLessThanOrEqual(counts.prompts)
      expect(counts.longestStreak).toBeLessThanOrEqual(counts.days)
      // The keys are the schema's own, and the only strings the two days.
      expect(Object.keys(counts).sort()).toEqual(
        ['commits', 'days', 'firstDay', 'lastDay', 'longestStreak', 'projects', 'prompts', 'sessions', 'testRuns', 'tools'],
      )
      expect(Object.keys(counts.tools).sort()).toEqual(['agent', 'bash', 'edit', 'mcp', 'other', 'read', 'search', 'web'])
      const strings = Object.values(counts).filter((value) => typeof value === 'string')
      for (const day of strings) expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(strings.length).toBe(earlier.length === 0 ? 0 : 2)
      if (counts.lastDay !== null) expect(Date.parse(`${counts.lastDay}T00:00:00Z`)).toBeLessThan(before)
    },
  )

  prop.prop('count nothing from a line of any other shape, and never throw', [Schema.String], ([line]) => {
    const tally = freshTally(before, 'UTC')
    expect(() => tallyLine(tally, line, 'p', 's')).not.toThrow()
    expect(countsOf(tally).prompts).toBe(0)
  })
})
