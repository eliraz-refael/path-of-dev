import type { AdminStats } from "@pathofdev/schema"
import { CurrentPlayer, OnlineApi } from "@pathofdev/schema"
import { Clock, Duration, Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { SqlClient, SqlSchema } from "effect/sql"
import { limitStats } from "../limits.ts"
import { RateLimiter } from "../rate-limit.ts"
import { adminOnly, Allowlist } from "./allowlist.ts"

// The public server's own numbers, from the mod: `/pathofdev admin stats` for its admins, so they can see how many
// play without a shell on the database. Counts alone leave: no login, name or id is selected, let alone sent.
//
//   GET /v1/admin/stats ─▶ BearerAuth ─▶ admin? (CurrentPlayer's GitHub user id ∈ ADMIN_GITHUB_IDS)
//                                          ├─ no ─▶ 403, nothing read
//                                          └─ yes ─▶ their own limit (limits.ts) ── over ─▶ 429, nothing read
//                                                      └─▶ one statement over players, event_log, player_history
//
// The windows run back from the server's Clock, never the database's now(), so a test sets the time: `lastDay` is the
// 24 hours before, `lastWeek` the 7 days, each from its very first millisecond on. The times are kept as ISO text, so
// both sides are read as timestamptz, the same on PGlite and Postgres whatever a row's offset spells.

export const onlyAdminsStats = "Only the server's admins can see its stats"

/** How far back each window runs. */
export const statsWindows = { lastDay: Duration.hours(24), lastWeek: Duration.days(7) }

const Since = Schema.Struct({ day: Schema.String, week: Schema.String })
const Row = Schema.Struct({
  players: Schema.Int,
  joinedDay: Schema.Int,
  joinedWeek: Schema.Int,
  publicProfiles: Schema.Int,
  playedEver: Schema.Int,
  playedDay: Schema.Int,
  playedWeek: Schema.Int,
  historyImported: Schema.Int,
  gradedDay: Schema.Int,
})

/**
 * The server's stats at `now` (ms): one statement, so every count reads the same snapshot of the tables, with one pass
 * over event_log. A public page is one with a login to reach it by: a rename that hands the login on clears it. A
 * player's play is the inputs their mod sent, events and commands: the server's own inputs ("system": missions rolled,
 * sessions kept live, a migration's carry) are left out, or a deploy would count everyone as playing that day.
 */
export const statsAt = (now: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const read = SqlSchema.findOne({
      Request: Since,
      Result: Row,
      execute: ({ day, week }) => sql`
        WITH joined AS (
          SELECT
            count(*)::int AS players,
            (count(*) FILTER (WHERE created_at::timestamptz >= ${day}::timestamptz))::int AS "joinedDay",
            (count(*) FILTER (WHERE created_at::timestamptz >= ${week}::timestamptz))::int AS "joinedWeek",
            (count(*) FILTER (WHERE profile -> 'public' = 'true'::jsonb AND github_login IS NOT NULL))::int
              AS "publicProfiles"
          FROM players
        ),
        per_player AS (
          SELECT
            max(received_at::timestamptz) FILTER (WHERE input ->> 'kind' IN ('client', 'command')) AS at,
            count(*) FILTER (
              WHERE status = 'accepted' AND input ->> 'kind' = 'client'
                AND input -> 'event' ->> 'type' = 'prompt.graded' AND received_at::timestamptz >= ${day}::timestamptz
            ) AS graded
          FROM event_log
          GROUP BY player_id
        ),
        played AS (
          SELECT
            count(at)::int AS "playedEver",
            (count(*) FILTER (WHERE at >= ${day}::timestamptz))::int AS "playedDay",
            (count(*) FILTER (WHERE at >= ${week}::timestamptz))::int AS "playedWeek",
            coalesce(sum(graded), 0)::int AS "gradedDay"
          FROM per_player
        )
        SELECT joined.*, played.*, (SELECT count(*)::int FROM player_history) AS "historyImported"
        FROM joined, played
      `,
    })
    const since = (window: Duration.Duration) => new Date(now - Duration.toMillis(window)).toISOString()
    const row = yield* read({ day: since(statsWindows.lastDay), week: since(statsWindows.lastWeek) })
    const stats: AdminStats = {
      players: { total: row.players, lastDay: row.joinedDay, lastWeek: row.joinedWeek },
      played: { ever: row.playedEver, lastDay: row.playedDay, lastWeek: row.playedWeek },
      publicProfiles: row.publicProfiles,
      historyImported: row.historyImported,
      promptsGraded: { lastDay: row.gradedDay },
    }
    return stats
  })

export const AdminHandlers = HttpApiBuilder.group(
  OnlineApi,
  "admin",
  Effect.fn(function* (handlers) {
    const allowlist = yield* Allowlist
    const limiter = yield* RateLimiter
    const sql = yield* SqlClient.SqlClient

    return handlers.handleAll({
      adminStats: () =>
        Effect.gen(function* () {
          const admin = yield* CurrentPlayer
          yield* adminOnly(allowlist, onlyAdminsStats)
          yield* limitStats(limiter, admin.id)
          const stats = Effect.flatMap(Clock.currentTimeMillis, statsAt)
          return yield* Effect.orDie(Effect.provideService(stats, SqlClient.SqlClient, sql))
        }),
    })
  }),
)
