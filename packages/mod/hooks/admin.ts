import type { AdminStats } from '@pathofdev/schema'
import type { HttpResponse } from 'claude-code'
import type { Route } from './server'
import { argsOf, commonTextOf, isCount, isRecord, parsed } from './server'

// The online server's own numbers, from the prompt: `/pathofdev admin stats`, for the server's admins (by GitHub user
// id, set on the server), as the beta list is. The mod sends the request with the player's game token and shows the
// counts; this file holds the pure half: the ask, its route, and the answer in the player's words.
//
//   /pathofdev admin stats ─▶ GET <origin>/v1/admin/stats, Bearer <game token>, the online origin only
//     answer ── 200 ────────────▶ a few lines of counts: players, who played, public pages, imports, graded prompts
//            ├─ 403 ────────────▶ "Only the server's admins can see its stats."
//            ├─ 401 ────────────▶ signed out: /pathofdev login
//            └─ none, 429, 5xx, … ─▶ not answering, or what it answered
//
// The answer holds counts alone, and the mod shows only the counts it knows, each a whole number: anything else the
// body holds is never printed.

/** What `/pathofdev admin …` asks. */
export type AdminAsk = { readonly kind: 'stats' }

export const adminUsage = "Server stats, for the online server's admins: /pathofdev admin stats."

export const onlyAdmins = "Only the server's admins can see its stats."

/** What `/pathofdev <args>` asks of the admins: null when the args aren't `admin …`, the usage if they don't parse. */
export const adminAskOf = (args: string): AdminAsk | string | null => {
  const [head, what, ...rest] = argsOf(args)
  if (head !== 'admin') return null
  return what === 'stats' && rest.length === 0 ? { kind: 'stats' } : adminUsage
}

/** The route the stats are asked on, to the online target. */
export const statsRoute: Route = { path: '/v1/admin/stats' }

const hasCounts = (value: unknown, keys: ReadonlyArray<string>): boolean =>
  isRecord(value) && keys.every((key) => isCount(value[key]))

/** Whether the server answered with every count the reply shows. */
export const isStats = (value: unknown): value is AdminStats =>
  isRecord(value) &&
  hasCounts(value['players'], ['total', 'lastDay', 'lastWeek']) &&
  hasCounts(value['played'], ['ever', 'lastDay', 'lastWeek']) &&
  hasCounts(value, ['publicProfiles', 'historyImported']) &&
  hasCounts(value['promptsGraded'], ['lastDay'])

/** The counts, a few short lines: "today" is the last 24 hours, "this week" the last 7 days, as the server counts. */
export const statsText = (stats: AdminStats, origin: string): string =>
  [
    `Path of Dev on ${origin} (today: the last 24 h, this week: the last 7 days):`,
    `Players: ${stats.players.total} (${stats.players.lastDay} today, ${stats.players.lastWeek} this week)`,
    `Played: ${stats.played.ever} ever, ${stats.played.lastDay} today, ${stats.played.lastWeek} this week`,
    `Public pages: ${stats.publicProfiles} · History imported: ${stats.historyImported} · ` +
      `Prompts graded today: ${stats.promptsGraded.lastDay}`,
  ].join('\n')

/** What the server made of an ask, in the player's words; `response` null: no answer at all. */
export const adminTextOf = (
  ask: AdminAsk,
  response: Pick<HttpResponse, 'ok' | 'status' | 'text'> | null,
  origin: string,
): string => {
  const common = commonTextOf(response, origin)
  if (common !== null || response === null) return common ?? ''
  if (response.status === 403) return onlyAdmins
  const body = parsed(response.text)
  if (response.ok && isStats(body)) return statsText(body, origin)
  return `The Path of Dev server at ${origin} answered the admin ${ask.kind} with ${response.status}.`
}
