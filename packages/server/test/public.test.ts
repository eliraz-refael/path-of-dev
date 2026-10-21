import { it } from "@effect/vitest"
import { engineVersion } from "@pathofdev/engine"
import { DevCommand } from "@pathofdev/schema"
import { Effect, Exit, Layer, Option, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { describe, expect } from "vitest"
import type { GithubUser, PublicConfig, PublicVar } from "../src/index.ts"
import {
  BadConfig,
  defaultPort,
  defaultProfileOrigin,
  GitHub,
  publicClientId,
  publicConfigOf,
  publicEnvOf,
} from "../src/index.ts"
import { dump, hatch, nextId, prompt, publicWebHandler, session, start, testPublicServices } from "./fixtures.ts"

// The public server as its entry wires it: its settings from the environment, and its routes over the core, online,
// with the beta's accounts. GitHub is a table the test fills.
//
//   env ─▶ publicConfigOf ─▶ PublicConfig            (round trip; a missing or bad var named)
//   Request ─▶ PublicRoutes ─▶ publicServices(db, allowlist, FakeGitHub)
//     /healthz ─▶ 200 │ dev commands ─▶ refused │ a newer save ─▶ 503 + Retry-After, nothing written
//     a string jsonb can't hold ─▶ that event invalid, the rest of its batch kept │ that command 400, nothing written

const serverRuns = { timeout: 120_000, arbitrary: { runs: 5 } }

// ── settings ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const Text = Schema.String.check(Schema.isPattern(/^[\x21-\x7e][\x20-\x7e]{0,40}$/))
const Config = Schema.Struct({
  databaseUrl: Text,
  signup: Schema.Literals(["open", "allowlist"]),
  allowedLogins: Text,
  adminGithubIds: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 999_999_999_999 }))).check(
    Schema.isMaxLength(4),
  ),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  clientId: Text,
  clientSecret: Text,
  profileOrigin: Schema.String.check(Schema.isPattern(/^https?:\/\/[a-z][a-z0-9]{0,20}(\.[a-z]{2,6}){0,2}$/)),
})

const configOf = (drawn: typeof Config.Type): PublicConfig => ({
  databaseUrl: Redacted.make(drawn.databaseUrl),
  signup: drawn.signup,
  allowedLogins: drawn.allowedLogins,
  adminGithubIds: drawn.adminGithubIds,
  port: drawn.port,
  github: { clientId: drawn.clientId, clientSecret: Redacted.make(drawn.clientSecret) },
  profileOrigin: drawn.profileOrigin,
})

/** A config with its secrets read out, so two can be compared. */
const plain = (config: PublicConfig) => ({
  ...config,
  databaseUrl: Redacted.value(config.databaseUrl),
  github: { ...config.github, clientSecret: Redacted.value(config.github.clientSecret) },
})

const Required = Schema.Literals(["DATABASE_URL", "GITHUB_CLIENT_SECRET"])

describe("the public server's settings", () => {
  it.effect.prop("read back from the env they are written to", [Config], ([drawn]) =>
    Effect.gen(function* () {
      const config = configOf(drawn)
      expect(plain(yield* publicConfigOf(publicEnvOf(config)))).toEqual(plain(config))
    }))

  it.effect.prop(
    "stop the boot on a required var missing or empty, naming it and nothing it holds",
    [Config, Required, Schema.Boolean],
    ([drawn, name, isEmpty]) =>
      Effect.gen(function* () {
        const env: Record<string, string | undefined> = {
          ...publicEnvOf(configOf(drawn)),
          [name]: isEmpty ? "" : undefined,
        }
        const exit = yield* Effect.exit(publicConfigOf(env))
        expect(exit).toEqual(Exit.fail(new BadConfig({ variable: name, isMissing: true })))
        const message = new BadConfig({ variable: name, isMissing: true }).message
        expect(message).toContain(name)
        for (const value of Object.values(env)) if (value !== undefined && value.length > 3) expect(message).not.toContain(value)
      }),
  )

  it.effect.prop(
    "stop the boot on a port that is not one, naming it",
    [Config, Schema.Literals(["http", "-1", "65536", "80.5", "0x"])],
    ([drawn, port]) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(publicConfigOf({ ...publicEnvOf(configOf(drawn)), PORT: port }))
        expect(exit).toEqual(Exit.fail(new BadConfig({ variable: "PORT", isMissing: false })))
      }),
  )

  it.effect.prop("take open signup, no beta list, the port, the public client id and no admins by default", [Config], ([drawn]) =>
    Effect.gen(function* () {
      const env: Partial<Record<PublicVar, string>> = { ...publicEnvOf(configOf(drawn)) }
      delete env.SIGNUP
      delete env.ALLOWED_LOGINS
      delete env.PORT
      delete env.GITHUB_CLIENT_ID
      delete env.ADMIN_GITHUB_IDS
      delete env.PROFILE_ORIGIN
      const config = yield* publicConfigOf(env)
      expect(config.signup).toBe("open")
      expect(config.allowedLogins).toBe("")
      expect(config.port).toBe(defaultPort)
      expect(config.github.clientId).toBe(publicClientId)
      expect(config.adminGithubIds).toEqual([])
      expect(config.profileOrigin).toBe(defaultProfileOrigin)
    }))

  it.effect.prop(
    "read SIGNUP in any case, and stop the boot on anything but open or allowlist, naming it",
    [Config, Schema.Literals(["Open", " allowlist ", "ALLOWLIST"]), Schema.Literals(["closed", "on", "true", "open,allowlist"])],
    ([drawn, spelt, bad]) =>
      Effect.gen(function* () {
        const env = publicEnvOf(configOf(drawn))
        expect((yield* publicConfigOf({ ...env, SIGNUP: spelt })).signup).toBe(spelt.trim().toLowerCase())
        const exit = yield* Effect.exit(publicConfigOf({ ...env, SIGNUP: bad }))
        expect(exit).toEqual(Exit.fail(new BadConfig({ variable: "SIGNUP", isMissing: false })))
      }),
  )

  it.effect.prop(
    "stop the boot on a profile origin that is not one: a path, a trailing slash, another scheme, not a URL",
    [Config, Schema.Literals(["/u", "/", "/u/"]), Schema.Literals(["ftp://pathof.dev", "pathof.dev", "https://", "u"])],
    ([drawn, path, junk]) =>
      Effect.gen(function* () {
        const env = publicEnvOf(configOf(drawn))
        for (const bad of [`${drawn.profileOrigin}${path}`, junk]) {
          const exit = yield* Effect.exit(publicConfigOf({ ...env, PROFILE_ORIGIN: bad }))
          expect(exit).toEqual(Exit.fail(new BadConfig({ variable: "PROFILE_ORIGIN", isMissing: false })))
        }
      }),
  )

  it.effect.prop(
    "read admins separated by commas or spaces, and stop the boot on one that is no GitHub user id, naming it",
    [Config, Schema.Literals([",", " ", ", ", "\n"]), Schema.Literals(["ada", "-1", "0", "1.5", "0x10", "12a"])],
    ([drawn, separator, bad]) =>
      Effect.gen(function* () {
        const env = publicEnvOf(configOf(drawn))
        const spaced = { ...env, ADMIN_GITHUB_IDS: ` ${drawn.adminGithubIds.join(separator)} ` }
        expect((yield* publicConfigOf(spaced)).adminGithubIds).toEqual(drawn.adminGithubIds)
        const listed = [...drawn.adminGithubIds.map(String), bad].join(separator)
        const exit = yield* Effect.exit(publicConfigOf({ ...env, ADMIN_GITHUB_IDS: listed }))
        expect(exit).toEqual(Exit.fail(new BadConfig({ variable: "ADMIN_GITHUB_IDS", isMissing: false })))
      }),
  )
})

// ── the routes ───────────────────────────────────────────────────────────────────────────────────────────────────────

const ada: GithubUser = { id: 1, login: "Ada", name: "Ada Lovelace" }

/** GitHub as the test fills it: the account each token signs in as; any other token GitHub turns down. */
const FakeGitHub = (accounts: ReadonlyMap<string, GithubUser>) =>
  Layer.succeed(
    GitHub,
    GitHub.of({ user: (token) => Effect.succeed(Option.fromNullishOr(accounts.get(Redacted.value(token)))) }),
  )

/** The public build, as its entry wires it, over a fresh database: Ada, signed in with `ada-token`, is on the list. */
const withPublic = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      testPublicServices({ signup: "open", allowedLogins: "", adminGithubIds: [] }, FakeGitHub(new Map([["ada-token", ada]]))),
    ),
  )

const request = (path: string, method: string, authorization: string | null, body?: unknown) =>
  new Request(`http://pathofdev.test${path}`, {
    method,
    headers: { "content-type": "application/json", ...(authorization === null ? {} : { authorization }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

/** Ada signed in: her game token, as the Authorization header. */
const signedIn = (handle: (request: Request) => Effect.Effect<Response>) =>
  Effect.gen(function* () {
    const response = yield* handle(request("/v1/auth/github", "POST", null, { githubToken: "ada-token", timezone: "UTC" }))
    expect(response.status).toBe(200)
    const body = (yield* Effect.promise(() => response.json())) as { token: string; player: { id: string } }
    return { bearer: `Bearer ${body.token}`, playerId: body.player.id }
  })

const json = (response: Response) => Effect.promise(() => response.json() as Promise<unknown>)

describe("the public build", () => {
  it.effect("answers the health check while the database does", () =>
    withPublic(
      Effect.gen(function* () {
        const handle = yield* publicWebHandler
        const response = yield* handle(request("/healthz", "GET", null))
        expect(response.status).toBe(200)
        expect(yield* Effect.promise(() => response.text())).toBe("ok")
      }),
    ))

  it.effect("acts for nobody without a token, though it holds a player", () =>
    withPublic(
      Effect.gen(function* () {
        const handle = yield* publicWebHandler
        yield* signedIn(handle)
        const before = yield* dump
        expect((yield* handle(request("/v1/events", "POST", null, { events: [prompt(8)] }))).status).toBe(401)
        expect((yield* handle(request("/v1/sessions", "POST", null, { sessionId: session }))).status).toBe(401)
        expect(yield* dump).toEqual(before)
      }),
    ))

  it.effect.prop(
    "refuses every dev command, never decoding it, and the save stays as it was",
    [Schema.Array(DevCommand).check(Schema.isMinLength(1), Schema.isMaxLength(6))],
    ([commands]) =>
      withPublic(
        Effect.gen(function* () {
          const handle = yield* publicWebHandler
          const { bearer } = yield* signedIn(handle)
          const sql = yield* SqlClient.SqlClient
          const saved = sql`SELECT state, server_seq FROM player_state`
          const before = yield* saved
          const rolls = yield* sql`SELECT * FROM rolls`
          // The public route decodes the commands of play alone: a dev command is no command there, answered 400
          // before any handler runs, so nothing of it is logged either.
          const logged = yield* sql`SELECT * FROM event_log`
          for (const command of commands) {
            const response = yield* handle(request("/v1/commands", "POST", bearer, command))
            expect({ type: command.type, status: response.status }).toEqual({ type: command.type, status: 400 })
          }
          expect(yield* sql`SELECT * FROM event_log`).toEqual(logged)
          expect(yield* saved).toEqual(before)
          expect(yield* sql`SELECT * FROM rolls`).toEqual(rolls)
          const opened = yield* handle(request("/v1/sessions", "POST", bearer, { sessionId: session }))
          expect(((yield* json(opened)) as { snapshot: { dev?: boolean } }).snapshot.dev).toBeUndefined()
        }),
      ),
    serverRuns,
  )
})

describe("a string jsonb can't hold", () => {
  // A NUL, or half of a surrogate pair: Postgres's jsonb takes neither, so the write would fail with a 500, and the mod
  // keeps its whole queue on a 5xx. The edge turns the one input away instead.
  const Unstorable = Schema.Tuple([
    Schema.String.check(Schema.isPattern(/^[a-z ]{0,8}$/)),
    Schema.Literals(["\u0000", "\ud83d", "\ude00"]),
    Schema.String.check(Schema.isPattern(/^[a-z ]{0,8}$/)),
  ])
  const passed = (runner: string) => ({
    id: nextId(),
    type: "tests.passed",
    occurredAt: start,
    sessionId: session,
    data: { checkout: null, runner },
  })

  it.effect.prop(
    "turns away the one event as invalid and takes the rest of its batch",
    [Unstorable],
    ([pieces]) =>
      withPublic(
        Effect.gen(function* () {
          const handle = yield* publicWebHandler
          const { bearer } = yield* signedIn(handle)
          const bad = passed(pieces.join(""))
          const batch = [prompt(8), bad, prompt(6)]
          const response = yield* handle(request("/v1/events", "POST", bearer, { events: batch }))
          expect(response.status).toBe(200)
          const { results } = (yield* json(response)) as { results: ReadonlyArray<{ id: string; status: string; reason?: string }> }
          expect(results.map(({ id, status, reason }) => ({ id, status, reason }))).toEqual([
            { id: batch[0]!.id, status: "accepted", reason: undefined },
            { id: bad.id, status: "rejected", reason: "invalid" },
            { id: batch[2]!.id, status: "accepted", reason: undefined },
          ])
        }),
      ),
    serverRuns,
  )

  it.effect.prop(
    "answers a command holding one 400, and writes nothing",
    [Unstorable],
    ([pieces]) =>
      withPublic(
        Effect.gen(function* () {
          const handle = yield* publicWebHandler
          const { bearer } = yield* signedIn(handle)
          const before = yield* dump
          const command = { ...hatch(), data: { species: "fox", name: pieces.join("") } }
          expect((yield* handle(request("/v1/commands", "POST", bearer, command))).status).toBe(400)
          expect(yield* dump).toEqual(before)
        }),
      ),
    serverRuns,
  )
})

describe("the version guard", () => {
  const Write = Schema.Literals(["events", "command", "open", "close"])

  const requestOf = (write: typeof Write.Type, bearer: string): Request => {
    switch (write) {
      case "events":
        return request("/v1/events", "POST", bearer, { events: [prompt(8)] })
      case "command":
        return request("/v1/commands", "POST", bearer, hatch())
      case "open":
        return request("/v1/sessions", "POST", bearer, { sessionId: session, presence: true })
      case "close":
        return request(`/v1/sessions/${session}`, "DELETE", bearer)
    }
  }

  // The stream only reads: its heartbeat moves a session's last-heard time, outside the save, so it is left out here.
  it.effect.prop(
    "answers every write 503 with Retry-After, and writes nothing, while a newer build saved the player, and only then",
    [
      Schema.Int.check(Schema.isBetween({ minimum: -2, maximum: 3 })),
      Schema.Array(Write).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
    ],
    ([ahead, writes]) =>
      withPublic(
        Effect.gen(function* () {
          const handle = yield* publicWebHandler
          const { bearer, playerId } = yield* signedIn(handle)
          // A session open, so closing it would write.
          expect((yield* handle(requestOf("open", bearer))).status).toBe(200)
          const sql = yield* SqlClient.SqlClient
          yield* sql`UPDATE player_state SET engine_version = ${engineVersion + ahead} WHERE player_id = ${playerId}`
          const before = yield* dump
          for (const write of writes) {
            const response = yield* handle(requestOf(write, bearer))
            if (ahead > 0) {
              expect({ write, status: response.status }).toEqual({ write, status: 503 })
              expect(response.headers.get("retry-after")).toBe("60")
              expect(yield* json(response)).toMatchObject({ _tag: "ServerBehind" })
            } else {
              expect({ write, status: response.status }).toEqual({ write, status: 200 })
            }
          }
          if (ahead > 0) expect(yield* dump).toEqual(before)
        }),
      ),
    { ...serverRuns, arbitrary: { runs: 12 } },
  )
})
