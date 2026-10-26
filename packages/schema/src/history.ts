import { Schema } from "effect"
import { Count, IsoDate, IsoDateTime } from "./primitives.ts"

// The player's Claude Code history from before Path of Dev, as `/pathofdev import history` counts it on their machine
// from Claude Code's own transcripts: counts and two dates, never a prompt, a path or a project's name. It is no part
// of the game: no XP, no badge, no event in the log, so a replay never reads it. The server keeps one row of it per
// player, replaced by each import, and a public page shows it only once the player shows the `history` section.
//
//   mod: GET /v1/history ─▶ { history, before }   before: when the player started (their `createdAt`)
//        reads the transcripts, counting only what happened before `before`
//        POST /v1/history { counts } ─▶ historyProblem ── says one ─▶ 400 InvalidHistory, nothing written
//                                        └─▶ the row replaced ─▶ { history, before }

/** The kinds a tool call is counted under: Claude Code's own tools by what they do, an MCP tool's as `mcp`. */
export const toolKinds = ["bash", "read", "edit", "search", "web", "agent", "mcp", "other"] as const
export type ToolKind = (typeof toolKinds)[number]

/** The most any count may be: well past a lifetime of sessions, so a count past it is no count at all. */
export const maxHistoryCount = 100_000_000

const HistoryCount = Count.pipe(Schema.check(Schema.isLessThanOrEqualTo(maxHistoryCount)))

/** A tool call count for each kind. */
export const ToolCounts = Schema.Struct({
  bash: HistoryCount,
  read: HistoryCount,
  edit: HistoryCount,
  search: HistoryCount,
  web: HistoryCount,
  agent: HistoryCount,
  mcp: HistoryCount,
  other: HistoryCount,
} satisfies Record<ToolKind, unknown>)
export interface ToolCounts extends Schema.Schema.Type<typeof ToolCounts> {}

/** `POST /v1/history`: what an import counted, as the mod sends it. */
export const HistoryCounts = Schema.Struct({
  /** The prompts the player typed: no tool result, no command's output, nothing Claude Code wrote itself. */
  prompts: HistoryCount,
  /** The sessions with a prompt in them. */
  sessions: HistoryCount,
  /** The projects, by Claude Code's folder for each, with a prompt in them: a count, never a name. */
  projects: HistoryCount,
  /** The local days with a prompt in them. */
  days: HistoryCount,
  /** The most of those days in a row. */
  longestStreak: HistoryCount,
  tools: ToolCounts,
  /** The Bash calls that ran a test suite, as the mod's own detector reads a command. */
  testRuns: HistoryCount,
  /** The `git commit`s the Bash calls ran, as the mod's own detector reads a command. */
  commits: HistoryCount,
  /** The first and the last of those days; null when there are none. */
  firstDay: Schema.NullOr(IsoDate),
  lastDay: Schema.NullOr(IsoDate),
})
export interface HistoryCounts extends Schema.Schema.Type<typeof HistoryCounts> {}

/** An import as the server keeps it: the counts, and when it took them. */
export const ImportedHistory = Schema.Struct({ ...HistoryCounts.fields, importedAt: IsoDateTime })
export interface ImportedHistory extends Schema.Schema.Type<typeof ImportedHistory> {}

/** `GET` and `POST /v1/history`: the import kept, if any, and the time before which an import counts. */
export const HistoryResponse = Schema.Struct({
  history: Schema.NullOr(ImportedHistory),
  /** When the player started on this server: anything from then on is the game's already, and never counted twice. */
  before: IsoDateTime,
})
export interface HistoryResponse extends Schema.Schema.Type<typeof HistoryResponse> {}

const dayMs = 86_400_000

/** Whether `day` is a day of the calendar, not only shaped like one: 2026-02-30 is not. */
const isRealDay = (day: string): boolean => {
  const ms = Date.parse(`${day}T00:00:00Z`)
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === day
}

/** The local days from `first` to `last`, both counted. */
const daysFrom = (first: string, last: string): number =>
  Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / dayMs) + 1

/**
 * What is wrong with counts an import sent for a player who started at `before`, in the player's words, or null when
 * they hold together: each count within what the others allow, the days real ones, and the last of them no later than
 * the day `before` falls on in any time zone, so nothing from the game's own time is counted twice.
 */
export const historyProblem = (counts: HistoryCounts, before: string): string | null => {
  const { prompts, sessions, projects, days, longestStreak, firstDay, lastDay } = counts
  if ((firstDay === null) !== (lastDay === null)) return "The history names a first day without a last, or the other way"
  if ((days === 0) !== (firstDay === null)) return "The history's days and its first and last day don't agree"
  if ((prompts === 0) !== (days === 0)) return "The history's prompts and its days don't agree"
  if (sessions > prompts || days > prompts) return "The history counts more sessions or days than prompts"
  if (projects > sessions) return "The history counts more projects than sessions"
  if (longestStreak > days || (days > 0 && longestStreak === 0)) return "The history's longest streak doesn't fit its days"
  if (counts.testRuns > counts.tools.bash) return "The history counts more test runs than Bash calls"
  if (firstDay === null || lastDay === null) return null
  if (!isRealDay(firstDay) || !isRealDay(lastDay)) return "The history names a day the calendar has no such day for"
  if (firstDay > lastDay) return "The history's first day is after its last"
  if (days > daysFrom(firstDay, lastDay)) return "The history counts more days than there are from its first to its last"
  // The earliest a local day starts is 14 hours before UTC's, in the zones furthest east.
  if (Date.parse(`${lastDay}T00:00:00Z`) - 14 * 3_600_000 >= Date.parse(before)) {
    return "The history counts days from after you started Path of Dev"
  }
  return null
}
