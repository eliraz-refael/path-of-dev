import { it } from "@effect/vitest"
import { AdminStats } from "@pathofdev/schema"
import { Duration, Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import type { BetaConfig, GithubUser } from "../src/index.ts"
import { limits, migrate, onlyAdminsStats, statsAt, statsWindows } from "../src/index.ts"
import type { Handle } from "./fixtures.ts"
import {
  dump,
  fakeGitHub,
  json,
  prompt,
  publicWebHandler,
  request,
  session,
  signIn,
  start,
  testPublicServices,
  testServices,
  testSql,
  webHandler,
} from "./fixtures.ts"

// The public server's stats, for its admins: the counts as properties over rows placed around each window's edge, and
// the route as the public build serves it.
//
//   statsAt(now) ─▶ the model's counts, whatever the rows │ a row at the window's first millisecond in, one before out
//   GET /v1/admin/stats ─▶ 401 signed out │ 403 no admin, nothing read │ 200 counts alone │ 429 past the limit
//   the local server ─▶ 404, no such route

const serverRuns = { timeout: 120_000, arbitrary: { runs: 8 } }

const day = Duration.toMillis(statsWindows.lastDay)
const week = Duration.toMillis(statsWindows.lastWeek)
const now = Date.parse(start)

// ── the counts ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** How long before now a row is: each window's edge, a millisecond either side, and anywhere in a month. */
const Ago = Schema.Union([
  Schema.Literals([0, 1, day - 1, day, day + 1, week - 1, week, week + 1]),
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30 * day })),
])

/** The offsets a time is spelt in, in minutes east: the same instant as text that sorts otherwise. */
const Zone = Schema.Literals([0, 330, -420, 840])

const Input = Schema.Struct({
  ago: Ago,
  zone: Zone,
  kind: Schema.Literals(["client", "command", "system"]),
  isGraded: Schema.Boolean,
  isAccepted: Schema.Boolean,
})

const Drawn = Schema.Struct({
  joined: Ago,
  zone: Zone,
  isPublic: Schema.Boolean,
  hasHistory: Schema.Boolean,
  inputs: Schema.Array(Input).check(Schema.isMaxLength(5)),
})

/** `ms` as ISO text in the zone `minutes` east of UTC: `…Z` at 0, else `…+05:30` and the like. */
const spelt = (ms: number, minutes: number): string => {
  if (minutes === 0) return new Date(ms).toISOString()
  const sign = minutes > 0 ? "+" : "-"
  const off = Math.abs(minutes)
  const zone = `${sign}${String(Math.floor(off / 60)).padStart(2, "0")}:${String(off % 60).padStart(2, "0")}`
  return new Date(ms + minutes * 60_000).toISOString().replace("Z", zone)
}

/** The players drawn, as rows straight in the tables: no game, just what the stats read. */
const place = (players: ReadonlyArray<typeof Drawn.Type>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    for (const [i, player] of players.entries()) {
      const id = `p${i}`
      const profile = JSON.stringify({ public: player.isPublic })
      yield* sql`
        INSERT INTO players (id, github_user_id, github_login, display_name, roll_seed, created_at, profile)
        VALUES (${id}, ${100 + i}, ${`login-${i}`}, ${`Name ${i}`}, 'seed', ${spelt(now - player.joined, player.zone)},
          ${profile}::jsonb)
      `
      if (player.hasHistory) {
        yield* sql`INSERT INTO player_history (player_id, counts, imported_at) VALUES (${id}, '{}'::jsonb, ${start})`
      }
      for (const [seq, input] of player.inputs.entries()) {
        const json = JSON.stringify(
          input.kind === "command"
            ? { kind: "command", command: { id: `c${seq}`, type: "character.rename", data: { name: "X" } } }
            : { kind: input.kind, event: { type: input.isGraded ? "prompt.graded" : "turn.completed" } },
        )
        yield* sql`
          INSERT INTO event_log (
            player_id, log_seq, input_id, natural_key, schema_version, input, received_at,
            engine_version, rules_version, catalog_version, status, reason, refusal
          ) VALUES (
            ${id}, ${seq + 1}, ${`${id}-${seq}`}, NULL, 1, ${json}::jsonb, ${spelt(now - input.ago, input.zone)},
            1, 1, 1, ${input.isAccepted ? "accepted" : "rejected"}, NULL, NULL
          )
        `
      }
    }
  })

/** The counts, said the long way. */
const modelOf = (players: ReadonlyArray<typeof Drawn.Type>): AdminStats => {
  const within = (ago: number, window: number) => ago <= window
  const played = players.map((player) => player.inputs.filter((input) => input.kind !== "system"))
  const last = played.flatMap((inputs) => (inputs.length === 0 ? [] : [Math.min(...inputs.map((one) => one.ago))]))
  const graded = players.flatMap((player) => player.inputs).filter(
    (input) => input.kind === "client" && input.isGraded && input.isAccepted && within(input.ago, day),
  )
  return {
    players: {
      total: players.length,
      lastDay: players.filter((player) => within(player.joined, day)).length,
      lastWeek: players.filter((player) => within(player.joined, week)).length,
    },
    played: {
      ever: last.length,
      lastDay: last.filter((ago) => within(ago, day)).length,
      lastWeek: last.filter((ago) => within(ago, week)).length,
    },
    publicProfiles: players.filter((player) => player.isPublic).length,
    historyImported: players.filter((player) => player.hasHistory).length,
    promptsGraded: { lastDay: graded.length },
  }
}

describe("the stats", () => {
  it.effect.prop(
    "count what the model counts, a row at a window's first millisecond in and one a millisecond older out",
    [Schema.Array(Drawn).check(Schema.isMaxLength(8))],
    ([players]) =>
      Effect.gen(function* () {
        yield* migrate
        yield* place(players)
        expect(yield* statsAt(now)).toEqual(modelOf(players))
      }).pipe(Effect.provide(testSql)),
    serverRuns,
  )

  it.effect("read each edge as the model does: in at 24 h and 7 days, out a millisecond past", () =>
    Effect.gen(function* () {
      yield* migrate
      const at = (joined: number, ago: number): typeof Drawn.Type => ({
        joined,
        zone: 0,
        isPublic: false,
        hasHistory: false,
        inputs: [{ ago, zone: 0, kind: "client", isGraded: true, isAccepted: true }],
      })
      yield* place([at(day - 1, day - 1), at(day, day), at(day + 1, day + 1), at(week, week), at(week + 1, week + 1)])
      expect(yield* statsAt(now)).toEqual({
        players: { total: 5, lastDay: 2, lastWeek: 4 },
        played: { ever: 5, lastDay: 2, lastWeek: 4 },
        publicProfiles: 0,
        historyImported: 0,
        promptsGraded: { lastDay: 2 },
      })
    }).pipe(Effect.provide(testSql)))

  it.effect("count nothing on an empty server", () =>
    Effect.gen(function* () {
      yield* migrate
      expect(yield* statsAt(now)).toEqual({
        players: { total: 0, lastDay: 0, lastWeek: 0 },
        played: { ever: 0, lastDay: 0, lastWeek: 0 },
        publicProfiles: 0,
        historyImported: 0,
        promptsGraded: { lastDay: 0 },
      })
    }).pipe(Effect.provide(testSql)))
})

// ── through the route ────────────────────────────────────────────────────────────────────────────────────────────────

const root: GithubUser = { id: 7, login: "root", name: "Root" }
const bob: GithubUser = { id: 2, login: "bob", name: null }
/** Root's login in another case, on another account: someone who took it after a rename. Never an admin. */
const mallory: GithubUser = { id: 8, login: "Root", name: null }

const beta: BetaConfig = { signup: "open", allowedLogins: "", adminGithubIds: [root.id] }

const withStats = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(testPublicServices(beta, fakeGitHub([root, bob, mallory]))))

const stats = (handle: Handle, bearer: string | null) => handle(request("/v1/admin/stats", "GET", bearer))

/** The status and body of an answer. */
const answer = (response: Response) => Effect.map(json(response), (body) => ({ status: response.status, body }))

/** Every leaf of a body, by its path, so a shape is checked key for key. */
const leaves = (value: unknown, path = ""): Array<readonly [string, unknown]> =>
  typeof value === "object" && value !== null
    ? Object.entries(value).flatMap(([key, inner]) => leaves(inner, `${path}.${key}`))
    : [[path, value]]

describe("GET /v1/admin/stats", () => {
  it.effect("answers an admin the counts alone: numbers at fixed keys, never a login, a name or an id", () =>
    withStats(
      Effect.gen(function* () {
        const handle = yield* publicWebHandler
        const admin = yield* signIn(handle, root)
        const player = yield* signIn(handle, bob)
        // Bob plays: a session, and a graded prompt.
        expect((yield* handle(request("/v1/sessions", "POST", player.bearer, { sessionId: session }))).status).toBe(200)
        expect((yield* handle(request("/v1/events", "POST", player.bearer, { events: [prompt(8)] }))).status).toBe(200)
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE players SET profile = '{"public": true}'::jsonb WHERE id = ${player.player.id}`
        const { status, body } = yield* answer(yield* stats(handle, admin.bearer))
        expect(status).toBe(200)
        expect(body).toEqual({
          players: { total: 2, lastDay: 2, lastWeek: 2 },
          played: { ever: 1, lastDay: 1, lastWeek: 1 },
          publicProfiles: 1,
          historyImported: 0,
          promptsGraded: { lastDay: 1 },
        })
        expect(Schema.decodeUnknownSync(AdminStats)(body)).toEqual(body)
        expect(leaves(body).map(([path]) => path).sort()).toEqual([
          ".historyImported",
          ".played.ever",
          ".played.lastDay",
          ".played.lastWeek",
          ".players.lastDay",
          ".players.lastWeek",
          ".players.total",
          ".promptsGraded.lastDay",
          ".publicProfiles",
        ])
        for (const [path, leaf] of leaves(body)) {
          expect({ path, isCount: Number.isSafeInteger(leaf) }).toEqual({ path, isCount: true })
        }
        const text = JSON.stringify(body)
        for (const named of ["root", "bob", "Root", admin.player.id, player.player.id]) {
          expect(text).not.toContain(named)
        }
      }),
    ))

  it.effect("goes by the server's clock: a row leaves the last 24 hours a millisecond after it is 24 hours old", () =>
    withStats(
      Effect.gen(function* () {
        const handle = yield* publicWebHandler
        const admin = yield* signIn(handle, root)
        const sql = yield* SqlClient.SqlClient
        // Bob joined 24 hours before the clock, and Mallory 7 days: each at their window's very first millisecond.
        yield* sql`
          INSERT INTO players (id, display_name, roll_seed, created_at)
          VALUES ('bob', 'Bob', 's', ${new Date(now - day).toISOString()}),
            ('mallory', 'Mallory', 's', ${new Date(now - week).toISOString()})
        `
        const first = yield* json(yield* stats(handle, admin.bearer))
        expect(first.players).toEqual({ total: 3, lastDay: 2, lastWeek: 3 })
        yield* TestClock.adjust(1)
        const later = yield* json(yield* stats(handle, admin.bearer))
        expect(later.players).toEqual({ total: 3, lastDay: 1, lastWeek: 2 })
      }),
    ))

  it.effect("answers a player who is no admin 403, as the beta list does, and reads nothing", () =>
    withStats(
      Effect.gen(function* () {
        const handle = yield* publicWebHandler
        yield* signIn(handle, root)
        // Mallory goes by Root's login now, in another case, on another account: never the admin.
        for (const account of [bob, mallory]) {
          const { bearer } = yield* signIn(handle, account)
          const before = yield* dump
          expect({ login: account.login, ...(yield* answer(yield* stats(handle, bearer))) }).toEqual({
            login: account.login,
            status: 403,
            body: { _tag: "Forbidden", message: onlyAdminsStats },
          })
          expect(yield* dump).toEqual(before)
        }
      }),
    ))

  it.effect("answers a request with no token, or one it never issued, 401", () =>
    withStats(
      Effect.gen(function* () {
        const handle = yield* publicWebHandler
        expect((yield* stats(handle, null)).status).toBe(401)
        expect((yield* stats(handle, "Bearer pod_madeup")).status).toBe(401)
      }),
    ))

  it.effect("answers an admin past their limit 429 with Retry-After, and again once the bucket fills", () =>
    withStats(
      Effect.gen(function* () {
        const handle = yield* publicWebHandler
        const admin = yield* signIn(handle, root)
        for (let i = 0; i < limits.stats.capacity; i++) expect((yield* stats(handle, admin.bearer)).status).toBe(200)
        const refused = yield* stats(handle, admin.bearer)
        expect(refused.status).toBe(429)
        expect(refused.headers.get("retry-after")).toBe(String(limits.stats.everyMs / 1000))
        expect(yield* json(refused)).toMatchObject({ _tag: "RateLimited", retryAfterMs: limits.stats.everyMs })
        yield* TestClock.adjust(limits.stats.everyMs)
        expect((yield* stats(handle, admin.bearer)).status).toBe(200)
      }),
    ))

  it.effect("is no route of the local server", () =>
    Effect.gen(function* () {
      const handle = yield* webHandler
      expect((yield* stats(handle, null)).status).toBe(404)
    }).pipe(Effect.provide(testServices())))
})
