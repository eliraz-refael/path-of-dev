import type { HistoryCounts, HistoryResponse, ImportedHistory, ToolCounts } from '@pathofdev/schema'
import type { Row } from './cells'
import { counted, dim } from './cells'
import { commitsIn, testRunner } from './observe'
import type { Target } from './server'
import { argsOf, isRecord } from './server'

// `/pathofdev import history`: the player's Claude Code work from before Path of Dev, counted on their machine from
// Claude Code's own transcripts, and kept by the server apart from the game: no XP, no badge, no event. This file
// holds the pure half: which files are transcripts, what a line of one counts as, the counts the mod sends, and what
// the player hears. register.tsx lists and reads the files.
//
//   GET /v1/history ─▶ before (when the player started) ─┐
//   <config>/projects/<project>/<session>.jsonl, each ───┴─▶ tallyLine, line by line, only what is dated before it
//     ├─ a file up to 4 MiB: $.fs.read
//     ├─ a bigger one: streamed through `cat`, line by line, so no read holds more than a line of it
//     └─ one neither reads: skipped, and counted, for the reply
//   countsOf(tally) ─▶ POST /v1/history ─▶ the reply, and the Stats tab's card
//
// Only counts and two days leave the machine: never a prompt's text, a command, a path, a project's or a tool's name.
// Claude Code's line format is its own and changes between versions (code.claude.com/docs/en/sessions), so a line is
// read for the few fields it needs, and one without them, or that doesn't parse, counts as nothing:
//
//   type "user" | "assistant" (others: summaries, snapshots, system lines, skipped)   timestamp: ISO, else skipped
//   isSidechain true: a subagent's, skipped     uuid: a message's id, so a copy of it in a resumed session counts once
//   user: message.content, a string or blocks: a prompt unless it holds a tool_result, is meta (isMeta, isCompactSummary,
//         isVisibleInTranscriptOnly, isSynthetic, toolUseResult) or is what Claude Code wrote for a command
//         (`<command-name>`, `<local-command-stdout>`, `<bash-input>`, …)
//   assistant: message.content blocks of type tool_use, each by its `id` once, its `name` read for its kind alone, and
//         a Bash call's `input.command` read by the mod's own test and commit detectors, then dropped

/** What `/pathofdev import …` asks. */
export type HistoryAsk = { readonly kind: 'import' }

export const historyUsage =
  'Counts your Claude Code work from before Path of Dev, from its transcripts on this machine: /pathofdev import history.'

/** What `/pathofdev <args>` asks of the history: null when the args are not `import …`, the usage when they don't parse. */
export const historyAskOf = (args: string): HistoryAsk | string | null => {
  const [head, what, ...rest] = argsOf(args)
  if (head !== 'import') return null
  return what === 'history' && rest.length === 0 ? { kind: 'import' } : historyUsage
}

/** The most `$.fs.read` takes of a file: a bigger one is streamed. */
export const readLimit = 4 * 1024 * 1024

/** The longest line the stream holds while it waits for the line's end; past it, the line counts as nothing. */
export const maxLine = 32 * 1024 * 1024

/**
 * The folder Claude Code keeps its transcripts in: `projects` under `CLAUDE_CONFIG_DIR` when set, else under
 * `~/.claude`. Null with neither a config folder nor a home.
 */
export const projectsDirOf = (configDir: string | undefined, home: string | undefined): string | null => {
  const config = configDir !== undefined && configDir !== '' ? configDir : home ? `${home}/.claude` : null
  return config === null ? null : `${config.replace(/\/+$/, '')}/projects`
}

/**
 * A session's transcript, by the entry's name in a project's folder: `<session>.jsonl`. Not a copy Claude Code set
 * aside (`.orphaned-…`), nor a subagent's (`agent-…`, as older versions kept them beside the session).
 */
export const isTranscript = (entry: { readonly name: string; readonly kind: string }): boolean =>
  entry.kind === 'file' &&
  entry.name.endsWith('.jsonl') &&
  !entry.name.includes('.orphaned-') &&
  !entry.name.startsWith('agent-')

/** The kind a tool is counted under, by its name; the name itself goes no further. */
export const toolKindOf = (name: string): keyof ToolCounts => {
  if (name.startsWith('mcp__')) return 'mcp'
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return 'bash'
    case 'Read':
    case 'NotebookRead':
      return 'read'
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return 'edit'
    case 'Glob':
    case 'Grep':
    case 'LS':
      return 'search'
    case 'WebFetch':
    case 'WebSearch':
      return 'web'
    case 'Task':
    case 'Agent':
      return 'agent'
    default:
      return 'other'
  }
}

// What Claude Code writes as a user line for a slash command, its output, a `!` shell command, a background task's
// notice or a hook's context: none of it is a prompt the player typed.
const machineMade =
  /^<(?:command-name|command-message|command-args|command-contents|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|task-notification|system-reminder|user-prompt-submit-hook)\b/

const machineLines = ['[Request interrupted by user', 'Caveat: The messages below were generated by the user']

/** The flags Claude Code marks a user line it wrote itself with. */
const metaFlags = ['isMeta', 'isCompactSummary', 'isVisibleInTranscriptOnly', 'isSynthetic']

/** Whether a user line is a prompt the player typed: text or an image of theirs, and nothing Claude Code wrote. */
export const isPrompt = (entry: Record<string, unknown>): boolean => {
  if (metaFlags.some((flag) => entry[flag] === true) || entry['toolUseResult'] !== undefined) return false
  const message = entry['message']
  const content = isRecord(message) ? message['content'] : undefined
  let text = ''
  let hasImage = false
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block)) continue
      if (block['type'] === 'tool_result') return false
      if (block['type'] === 'text' && typeof block['text'] === 'string') text += block['text']
      if (block['type'] === 'image') hasImage = true
    }
  } else return false
  const typed = text.trim()
  if (typed === '') return hasImage
  return !machineMade.test(typed) && !machineLines.some((line) => typed.startsWith(line))
}

/** The counts so far, as the files are read; its sets hold ids, days and folder names, which never leave the mod. */
export type Tally = {
  /** Only what is dated before this, in ms, counts. */
  readonly before: number
  readonly day: (ms: number) => string
  readonly prompts: Set<string>
  readonly toolCalls: Set<string>
  readonly tools: Record<keyof ToolCounts, number>
  readonly days: Set<string>
  readonly sessions: Set<string>
  readonly projects: Set<string>
  testRuns: number
  commits: number
  /** Prompts with no id of their own, each counted as it comes. */
  unnamed: number
}

/** A fresh tally of what is dated before `before` (ms), its days read in `timeZone`. */
export const freshTally = (before: number, timeZone: string): Tally => {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  return {
    before,
    day: (ms) => format.format(new Date(ms)),
    prompts: new Set(),
    toolCalls: new Set(),
    tools: { bash: 0, read: 0, edit: 0, search: 0, web: 0, agent: 0, mcp: 0, other: 0 },
    days: new Set(),
    sessions: new Set(),
    projects: new Set(),
    testRuns: 0,
    commits: 0,
    unnamed: 0,
  }
}

/** What `tally` has counted so far, as a copy it can be put back to: for a file that may fail part way. */
export const savedTally = (tally: Tally): Tally => ({
  ...tally,
  prompts: new Set(tally.prompts),
  toolCalls: new Set(tally.toolCalls),
  tools: { ...tally.tools },
  days: new Set(tally.days),
  sessions: new Set(tally.sessions),
  projects: new Set(tally.projects),
})

/** Puts `tally` back to `saved`, so a file that failed part way leaves nothing of itself counted. */
export const restoreTally = (tally: Tally, saved: Tally): void => {
  const refill = (set: Set<string>, from: Set<string>) => {
    set.clear()
    for (const item of from) set.add(item)
  }
  refill(tally.prompts, saved.prompts)
  refill(tally.toolCalls, saved.toolCalls)
  refill(tally.days, saved.days)
  refill(tally.sessions, saved.sessions)
  refill(tally.projects, saved.projects)
  Object.assign(tally.tools, saved.tools)
  tally.testRuns = saved.testRuns
  tally.commits = saved.commits
  tally.unnamed = saved.unnamed
}

const parsedLine = (line: string): unknown => {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

/** One tool call of an assistant line: by its id once, its kind, and a Bash call's tests and commits. */
const tallyTool = (tally: Tally, block: Record<string, unknown>) => {
  const id = block['id']
  const name = block['name']
  if (typeof id !== 'string' || typeof name !== 'string' || tally.toolCalls.has(id)) return
  tally.toolCalls.add(id)
  const kind = toolKindOf(name)
  tally.tools[kind] += 1
  const input = block['input']
  const command = isRecord(input) ? input['command'] : undefined
  if (kind !== 'bash' || typeof command !== 'string') return
  if (testRunner(command) !== null) tally.testRuns += 1
  tally.commits += commitsIn(command, undefined).length
}

/**
 * Counts one line of a transcript, from the project folder `project` and the session `session`: a prompt typed, or
 * the tool calls of an answer, dated before the tally's `before`. Anything else, a line that doesn't parse included,
 * counts as nothing; it never throws.
 */
export const tallyLine = (tally: Tally, line: string, project: string, session: string): void => {
  if (!line.includes('"user"') && !line.includes('"assistant"')) return
  const entry = parsedLine(line)
  if (!isRecord(entry) || entry['isSidechain'] === true) return
  const type = entry['type']
  if (type !== 'user' && type !== 'assistant') return
  const at = typeof entry['timestamp'] === 'string' ? Date.parse(entry['timestamp']) : Number.NaN
  if (!Number.isFinite(at) || at >= tally.before) return
  if (type === 'user') {
    if (!isPrompt(entry)) return
    const uuid = entry['uuid']
    if (typeof uuid === 'string') {
      if (tally.prompts.has(uuid)) return
      tally.prompts.add(uuid)
    } else tally.unnamed += 1
    tally.days.add(tally.day(at))
    tally.sessions.add(`${project}/${session}`)
    tally.projects.add(project)
    return
  }
  const message = entry['message']
  const content = isRecord(message) ? message['content'] : undefined
  if (!Array.isArray(content)) return
  for (const block of content) if (isRecord(block) && block['type'] === 'tool_use') tallyTool(tally, block)
}

/** Every line of `text`, a whole file, counted. */
export const tallyText = (tally: Tally, text: string, project: string, session: string): void => {
  for (const line of text.split('\n')) tallyLine(tally, line, project, session)
}

/**
 * Lines out of a stream's pieces, each handed to `take` once its end comes: a piece may end mid-line, or hold many. A
 * line longer than `limit` is dropped as it grows, never held whole.
 */
export const lineReader = (take: (line: string) => void, limit = maxLine) => {
  let carry = ''
  let isDropping = false
  return {
    push: (text: string) => {
      let from = 0
      for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', from)) {
        if (!isDropping && carry.length + end - from <= limit) take(carry + text.slice(from, end))
        carry = ''
        isDropping = false
        from = end + 1
      }
      if (isDropping) return
      carry += text.slice(from)
      if (carry.length > limit) {
        carry = ''
        isDropping = true
      }
    },
    end: () => {
      if (!isDropping && carry !== '') take(carry)
      carry = ''
      isDropping = false
    },
  }
}

const dayMs = 86_400_000

/** The most days in a row among `days` (`YYYY-MM-DD`, any order). */
export const longestStreakOf = (days: Iterable<string>): number => {
  const sorted = [...new Set(days)].map((day) => Date.parse(`${day}T00:00:00Z`)).filter(Number.isFinite).sort((a, b) => a - b)
  let best = 0
  let run = 0
  sorted.forEach((ms, i) => {
    run = i > 0 && ms - (sorted[i - 1] ?? 0) === dayMs ? run + 1 : 1
    best = Math.max(best, run)
  })
  return best
}

/** What the tally comes to, as the mod sends it: counts and the first and last day, nothing else. */
export const countsOf = (tally: Tally): HistoryCounts => {
  const days = [...tally.days].sort()
  return {
    prompts: tally.prompts.size + tally.unnamed,
    sessions: tally.sessions.size,
    projects: tally.projects.size,
    days: days.length,
    longestStreak: longestStreakOf(days),
    tools: { ...tally.tools },
    testRuns: tally.testRuns,
    commits: tally.commits,
    firstDay: days[0] ?? null,
    lastDay: days.at(-1) ?? null,
  }
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0

const countKeys = ['prompts', 'sessions', 'projects', 'days', 'longestStreak', 'testRuns', 'commits'] as const

/** The history a server's answer carries, when it has the counts the mod draws. */
export const isImported = (value: unknown): value is ImportedHistory =>
  isRecord(value) &&
  countKeys.every((key) => isCount(value[key])) &&
  isRecord(value['tools']) &&
  Object.values(value['tools']).every(isCount) &&
  (value['firstDay'] === null || typeof value['firstDay'] === 'string') &&
  (value['lastDay'] === null || typeof value['lastDay'] === 'string')

/** A server's answer to `/v1/history`, its `before` an instant: one that doesn't parse would let every line count. */
export const isHistoryAnswer = (value: unknown): value is HistoryResponse =>
  isRecord(value) &&
  typeof value['before'] === 'string' &&
  Number.isFinite(Date.parse(value['before'])) &&
  (value['history'] === null || isImported(value['history']))

const some = (count: number, one: string, many: string): string => `${counted(count)} ${count === 1 ? one : many}`

/** Every tool call counted, whatever its kind. */
export const toolCallsOf = (tools: Readonly<Record<string, number>>): number =>
  Object.values(tools).reduce((sum, count) => sum + count, 0)

/** The day an instant falls on, as the reply names it: the date alone. */
const dayOf = (iso: string): string => iso.slice(0, 10)

/**
 * What the player hears once the counts are kept, with how to show them, and the files that could not be read. Online,
 * `isShown` is whether the public page shows the history section, as the server last said; null when it didn't say.
 */
export const importedText = (counts: HistoryCounts, target: Target, skipped: number, isShown: boolean | null = null): string => {
  const span =
    counts.firstDay === null || counts.lastDay === null
      ? ''
      : counts.firstDay === counts.lastDay
        ? ` (${counts.firstDay})`
        : ` (${counts.firstDay} to ${counts.lastDay})`
  const numbers =
    `${some(counts.prompts, 'prompt', 'prompts')} in ${some(counts.sessions, 'session', 'sessions')} across ` +
    `${some(counts.projects, 'project', 'projects')}, on ${some(counts.days, 'day', 'days')} ` +
    `(longest streak ${some(counts.longestStreak, 'day', 'days')}); ${some(toolCallsOf(counts.tools), 'tool call', 'tool calls')}, ` +
    `${some(counts.testRuns, 'test run', 'test runs')} and ${some(counts.commits, 'commit', 'commits')}.`
  const where =
    target.kind !== 'online'
      ? ' It shows in the Stats tab of /pathofdev.'
      : isShown === true
        ? ' It shows in the Stats tab of /pathofdev, and on your public page while that is public.'
        : isShown === false
          ? ' It shows in the Stats tab of /pathofdev, and is hidden on your public page: /pathofdev profile show history adds it.'
          : ' It shows in the Stats tab of /pathofdev; /pathofdev profile says whether your public page shows it.'
  const unread = skipped === 0 ? '' : ` ${some(skipped, 'transcript', 'transcripts')} could not be read and ${skipped === 1 ? 'was' : 'were'} left out.`
  return (
    `Imported your Claude Code history from before Path of Dev${span}: ${numbers} Only these counts left this ` +
    `machine: no prompt, code, path or project name. It earns no XP.${where}${unread}`
  )
}

/** What the player hears when the folder holds no transcript. */
export const noTranscriptsText = (dir: string): string =>
  `Found no Claude Code transcripts in ${dir}, so there is nothing to import. Claude Code keeps them there unless ` +
  'CLAUDE_CONFIG_DIR says otherwise, and deletes those older than its cleanupPeriodDays setting (30 days by default).'

/** What the player hears when the transcripts hold nothing from before they started. */
export const nothingBeforeText = (before: string, files: number, skipped: number): string => {
  const unread = skipped === 0 ? '' : `, and ${some(skipped, 'transcript', 'transcripts')} could not be read`
  return (
    `None of your ${some(files, 'Claude Code transcript', 'Claude Code transcripts')} has a prompt from before you ` +
    `started Path of Dev on ${dayOf(before)}${unread}: nothing to import.`
  )
}

/** The Stats tab's card rows of an import: what it counted, a kind of tool call per row where there were any. */
export const historyRows = (history: ImportedHistory): ReadonlyArray<{ label: Row; value: string }> => {
  const kinds: ReadonlyArray<[keyof ToolCounts, string]> = [
    ['bash', 'Bash'],
    ['read', 'reads'],
    ['edit', 'edits'],
    ['search', 'searches'],
    ['web', 'web'],
    ['agent', 'agents'],
    ['mcp', 'MCP'],
    ['other', 'other'],
  ]
  const used = kinds.filter(([kind]) => (history.tools[kind] ?? 0) > 0)
  return [
    { label: [{ text: 'Prompts' }], value: counted(history.prompts) },
    { label: [{ text: 'Sessions' }], value: counted(history.sessions) },
    { label: [{ text: 'Days active' }], value: counted(history.days) },
    { label: [{ text: 'Longest streak' }], value: some(history.longestStreak, 'day', 'days') },
    { label: [{ text: 'Projects' }], value: counted(history.projects) },
    { label: [{ text: 'Tool calls' }], value: counted(toolCallsOf(history.tools)) },
    ...used.map(([kind, name], i) => ({
      label: [dim(i === used.length - 1 ? '└ ' : '├ '), dim(name)],
      value: counted(history.tools[kind] ?? 0),
    })),
    { label: [{ text: 'Test runs' }], value: counted(history.testRuns) },
    { label: [{ text: 'Commits' }], value: counted(history.commits) },
  ]
}

/** The card's last line: the days the counts span. */
export const historySpan = (history: ImportedHistory): string =>
  history.firstDay === null || history.lastDay === null
    ? 'Counted from your Claude Code transcripts'
    : `${history.firstDay} to ${history.lastDay}, before Path of Dev`
