import { it } from "@effect/vitest"
import type { HistoryCounts } from "@pathofdev/schema"
import { historyProblem, maxHistoryCount, toolKinds } from "@pathofdev/schema"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { describe, expect } from "vitest"
import type { GithubUser } from "../src/index.ts"
import type { Handle } from "./fixtures.ts"
import {
  dump,
  fakeGitHub,
  json,
  publicWebHandler,
  request,
  session,
  signIn,
  start,
  testPublicServices,
  webHandler,
  withServer,
} from "./fixtures.ts"

// The history an import brings from before Path of Dev, end to end: kept apart from the game, one row a player,
// replaced by each import, held together by `historyProblem`, and on a public page only once the player shows it.
//
//   GET  /v1/history ─▶ { history: null | kept, before: createdAt }
//   POST /v1/history { counts } ─▶ historyProblem ─▶ 400, nothing written │ the row replaced ─▶ 200 { history, before }
//   GET /u/:login ─▶ the history section only when public, shown, and imported

const serverRuns = { timeout: 120_000, arbitrary: { runs: 5 } }

const noTools = { bash: 0, read: 0, edit: 0, search: 0, web: 0, agent: 0, mcp: 0, other: 0 }

const counts: HistoryCounts = {
  prompts: 120,
  sessions: 14,
  projects: 3,
  days: 9,
  longestStreak: 4,
  tools: { ...noTools, bash: 60, read: 80, edit: 40, mcp: 5 },
  testRuns: 12,
  commits: 7,
  firstDay: "2026-08-01",
  lastDay: "2026-10-08",
}

const none: HistoryCounts = { ...counts, prompts: 0, sessions: 0, projects: 0, days: 0, longestStreak: 0, firstDay: null, lastDay: null }

/** Every table the game writes, to see that an import touches none of them. */
const gameRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return yield* Effect.forEach(
    ["player_state", "event_log", "server_events", "rolls", "quarantine"] as const,
    (table) => sql`SELECT * FROM ${sql(table)} ORDER BY 1, 2`,
  )
})

const historyRows = Effect.flatMap(SqlClient.SqlClient, (sql) => sql<Record<string, unknown>>`SELECT * FROM player_history`)

const post = (handle: Handle, body: unknown, bearer: string | null = null) =>
  handle(request("/v1/history", "POST", bearer, body))

describe("the history, on a local server", () => {
  it.effect("is none until an import, which it keeps apart from the game and answers with the time it counts before", () =>
    withServer(
      Effect.gen(function* () {
        const handle = yield* webHandler
        expect((yield* handle(request("/v1/sessions", "POST", null, { sessionId: session }))).status).toBe(200)
        expect(yield* json(yield* handle(request("/v1/history", "GET", null)))).toEqual({ history: null, before: start })
        const game = yield* gameRows
        const answer = yield* post(handle, counts)
        expect(answer.status).toBe(200)
        expect(yield* json(answer)).toEqual({ history: { ...counts, importedAt: start }, before: start })
        expect(yield* json(yield* handle(request("/v1/history", "GET", null)))).toEqual({
          history: { ...counts, importedAt: start },
          before: start,
        })
        // No XP, no event, no state: the game's rows are as they were.
        expect(yield* gameRows).toEqual(game)
      }),
    ))

  it.effect("replaces the import whole on the next one, in its one row", () =>
    withServer(
      Effect.gen(function* () {
        const handle = yield* webHandler
        expect((yield* post(handle, counts)).status).toBe(200)
        const again = { ...counts, prompts: 130, tools: { ...noTools, bash: 61 }, testRuns: 1, commits: 0 }
        expect((yield* post(handle, again)).status).toBe(200)
        const rows = yield* historyRows
        expect(rows).toHaveLength(1)
        expect(rows[0]?.["counts"]).toEqual(again)
        // An import that found nothing replaces it too.
        expect((yield* post(handle, none)).status).toBe(200)
        expect((yield* historyRows)[0]?.["counts"]).toEqual(none)
      }),
    ))

  it.effect("keeps only the counts' own keys: anything else the body carries is never stored", () =>
    withServer(
      Effect.gen(function* () {
        const handle = yield* webHandler
        const extra = { ...counts, prompt: "zqsecretzq", path: "/home/zqsecretzq", tools: { ...counts.tools, zqtoolzq: 3 } }
        expect((yield* post(handle, extra)).status).toBe(200)
        expect(JSON.stringify(yield* historyRows)).not.toContain("zq")
        expect(JSON.stringify(yield* json(yield* handle(request("/v1/history", "GET", null))))).not.toContain("zq")
      }),
    ))

  it.effect("turns down counts that don't hold together, or count days from after the player started, writing nothing", () =>
    withServer(
      Effect.gen(function* () {
        const handle = yield* webHandler
        const bad: ReadonlyArray<unknown> = [
          { ...counts, lastDay: "2026-10-10" },
          { ...counts, sessions: 121 },
          { ...counts, projects: 15 },
          { ...counts, longestStreak: 10 },
          { ...counts, firstDay: "2026-10-09", lastDay: "2026-10-08" },
          { ...counts, firstDay: "2026-02-30" },
          { ...counts, days: 0 },
          { ...counts, testRuns: 61 },
          { ...counts, prompts: maxHistoryCount + 1 },
          { ...counts, prompts: -1 },
          { ...counts, prompts: 1.5 },
          { ...counts, tools: { bash: 1 } },
          { ...counts, firstDay: "yesterday" },
          "counts",
        ]
        for (const body of bad) {
          const answer = yield* post(handle, body)
          expect({ body, status: answer.status }).toEqual({ body, status: 400 })
        }
        expect(yield* historyRows).toEqual([])
      }),
    ))
})

// ── the counts' own checks ──────────────────────────────────────────────────────────────────────────────────────────

/** Counts as an import makes them: from the days with prompts on them, and the prompts on each. */
const Made = Schema.Struct({
  first: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 400 })),
  offsets: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 60 }))).check(Schema.isMaxLength(30)),
  extra: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 50 })),
  bash: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 50 })),
})

const dayAt = (ms: number) => new Date(ms).toISOString().slice(0, 10)

const madeOf = ({ first, offsets, extra, bash }: typeof Made.Type): HistoryCounts => {
  const base = Date.parse("2025-03-01T00:00:00Z") + first * 86_400_000
  const days = [...new Set(offsets.map((offset) => dayAt(base + offset * 86_400_000)))].sort()
  let best = 0
  let run = 0
  days.forEach((day, i) => {
    run = i > 0 && Date.parse(day) - Date.parse(days[i - 1]!) === 86_400_000 ? run + 1 : 1
    best = Math.max(best, run)
  })
  const prompts = days.length === 0 ? 0 : days.length + extra
  return {
    prompts,
    sessions: Math.min(prompts, days.length),
    projects: Math.min(1, days.length),
    days: days.length,
    longestStreak: best,
    tools: { ...noTools, bash },
    testRuns: Math.floor(bash / 2),
    commits: bash,
    firstDay: days[0] ?? null,
    lastDay: days.at(-1) ?? null,
  }
}

describe("historyProblem", () => {
  it.prop("takes every count an import makes from days before the player started", [Made], ([made]) => {
    expect(historyProblem(madeOf(made), start)).toBeNull()
  })

  it.prop("turns down any of them moved to the day after the player started", [Made], ([made]) => {
    const counts = madeOf(made)
    if (counts.lastDay === null) return
    expect(historyProblem({ ...counts, lastDay: "2026-10-10" }, start)).not.toBeNull()
  })

  it("names every tool kind the counts carry", () => {
    expect(Object.keys(counts.tools).sort()).toEqual([...toolKinds].sort())
  })
})

// ── the public page ─────────────────────────────────────────────────────────────────────────────────────────────────

const ada: GithubUser = { id: 1, login: "Ada", name: null }

const withPublic = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(testPublicServices({ signup: "allowlist", allowedLogins: "ada", adminGithubIds: [] }, fakeGitHub([ada]))))

const page = (handle: Handle) =>
  Effect.flatMap(handle(new Request("http://pathofdev.test/u/ada")), (response) =>
    Effect.promise(async () => ({ status: response.status, body: await response.text() })))

const profile = (handle: Handle, bearer: string, change: Record<string, string>) =>
  Effect.flatMap(handle(request("/v1/account/profile", "POST", bearer, change)), (response) =>
    Effect.sync(() => expect(response.status).toBe(200)))

describe("the history on a public page", () => {
  it.effect("starts hidden, shows once the player shows it, never on a private page, and keeps the latest import", () =>
    withPublic(
      Effect.gen(function* () {
        const handle = yield* publicWebHandler
        const { bearer } = yield* signIn(handle, ada)
        expect((yield* post(handle, counts, bearer)).status).toBe(200)
        // Private: the one 404, history or not.
        expect((yield* page(handle)).status).toBe(404)
        yield* profile(handle, bearer, { kind: "public" })
        const hidden = yield* page(handle)
        expect(hidden.status).toBe(200)
        expect(hidden.body).not.toContain('aria-labelledby="history"')
        expect(hidden.body).not.toContain("Before Path of Dev")
        const settings = yield* json(yield* handle(request("/v1/account/profile", "GET", bearer)))
        expect(settings.hidden).toEqual(["history"])

        yield* profile(handle, bearer, { kind: "show", section: "history" })
        const shown = (yield* page(handle)).body
        expect(shown).toContain('aria-labelledby="history"')
        expect(shown).toContain("Before Path of Dev")
        expect(shown).toContain("<b>120</b><span>prompts</span>")
        // Every tool call, summed.
        expect(shown).toContain("<b>185</b><span>tool calls</span>")
        expect(shown).toContain("Aug 1, 2026 – Oct 8, 2026")

        expect((yield* post(handle, { ...counts, prompts: 140 }, bearer)).status).toBe(200)
        expect((yield* page(handle)).body).toContain("<b>140</b><span>prompts</span>")

        yield* profile(handle, bearer, { kind: "private" })
        expect((yield* page(handle)).status).toBe(404)
      }),
    ), serverRuns.timeout)

  it.effect("has no section to show while nothing was imported, and the import itself writes nothing a page reads", () =>
    withPublic(
      Effect.gen(function* () {
        const handle = yield* publicWebHandler
        const { bearer } = yield* signIn(handle, ada)
        yield* profile(handle, bearer, { kind: "public" })
        yield* profile(handle, bearer, { kind: "show", section: "history" })
        expect((yield* page(handle)).body).not.toContain('aria-labelledby="history"')
        const before = yield* dump
        expect((yield* post(handle, counts, bearer)).status).toBe(200)
        expect(yield* dump).toEqual(before)
      }),
    ), serverRuns.timeout)

  it.effect("is turned away without a token, and its counts are each player's own", () =>
    withPublic(
      Effect.gen(function* () {
        const handle = yield* publicWebHandler
        expect((yield* post(handle, counts)).status).toBe(401)
        expect((yield* handle(request("/v1/history", "GET", null))).status).toBe(401)
        expect(yield* historyRows).toEqual([])
      }),
    ), serverRuns.timeout)
})
