import { it } from "@effect/vitest"
import { engineVersion } from "@pathofdev/engine"
import { clientEventTypes, SnapshotResponse } from "@pathofdev/schema"
import { Effect, Fiber, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import { streamTimeout } from "../src/index.ts"
import {
  client,
  commandUsed,
  commit,
  contextMeasured,
  fakeGitHub,
  hatch,
  json,
  merged,
  nextId,
  prompt,
  publicWebHandler,
  request,
  session,
  signIn,
  start,
  testPublicServices,
  untilAsleep,
  withoutQuests,
  withServer,
} from "./fixtures.ts"

describe("POST /v1/sessions", () => {
  it.effect("opens on the snapshot, the rules and the event types this server takes", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        const opened = yield* api.openSession({ payload: { sessionId: session } })
        // Opening on a new day rolls its missions first: the day's dailies and the week's weeklies, offered.
        expect(opened.snapshot.cursor).toBe(2)
        expect(opened.snapshot.character).toMatchObject({ name: "Player", level: 0, gold: 0 })
        expect(opened.snapshot.pet).toBeNull()
        expect(opened.snapshot.serverId).toBe(`local-${opened.snapshot.player.id}`)
        expect(opened.rules.version).toBe(14)
        expect(opened.acceptedEventTypes).toEqual(clientEventTypes)
      }),
    ),
  )
})

describe("POST /v1/events", () => {
  it.effect("answers each event in the order sent, with the server events the batch caused", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        const good = commit("a")
        const response = yield* api.sendEvents({ payload: { events: [{ id: "x", type: "pet.danced" }, good] } })
        expect(response.results).toEqual([
          { id: "x", status: "rejected", reason: "unknown_type" },
          { id: good.id, status: "accepted" },
        ])
        expect(withoutQuests(response.events).map((event) => event.type)).toEqual([
          "xp.granted",
          "streak.changed",
          "xp.granted",
          "achievement.unlocked",
        ])
        const opened = yield* api.openSession({ payload: { sessionId: session } })
        expect(opened.snapshot.cursor).toBe(response.events.length)
        expect(opened.snapshot.character.xp.reported).toBe(13)
      }),
    ),
  )
})

describe("POST /v1/events: prompts and stats", () => {
  it.effect("prices graded prompts, counts the stats, and the snapshot carries them", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        const events = [prompt(10), prompt(10), commandUsed("/code-review"), contextMeasured(80)]
        const response = yield* api.sendEvents({ payload: { events } })
        expect(response.results.map((result) => result.status)).toEqual(["accepted", "accepted", "accepted", "accepted"])
        const prompts = response.events.flatMap((event) =>
          event.type === "xp.granted" && event.data.reason === "prompt.graded" ? [event.data.amount] : [],
        )
        // The same grade twice is two prompts, not one fact reported twice.
        expect(prompts).toEqual([20, 20])
        expect(response.events.filter((event) => event.type === "stats.changed")).toHaveLength(4)
        const opened = yield* api.openSession({ payload: { sessionId: session } })
        expect(opened.snapshot.character.xp.reported).toBe(10 + 40)
        expect(opened.snapshot.stats).toEqual({
          clears: 0,
          compactions: { manual: 0, auto: 0 },
          commands: { "/code-review": 1 },
          contextCrossed: { pct50: 1, pct75: 1, pct100: 0 },
          contextPeak: { lastSession: 80, average: 80 },
          prompts: { graded: 2, gradedToday: 2, averageScore: 10, regretted: 2 },
          grades: {
            best: 10,
            dimensions: { clarity: 10, grammar: 10, specificity: 10, instructive: 10, context: 10, doneCriteria: 10, focus: 10 },
          },
        })
        expect(opened.rules.prompt.maxXp).toBe(20)
      }),
    ),
  )
})

describe("POST /v1/commands", () => {
  it.effect("refuses what the rules refuse, and applies the rest", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        expect(yield* api.runCommand({ payload: hatch() })).toEqual({
          status: "refused",
          code: "not_allowed",
          message: "The egg hatches at level 1",
        })
        yield* api.sendEvents({ payload: { events: [merged(1)] } })
        const hatched = yield* api.runCommand({ payload: hatch() })
        expect(hatched.status === "ok" && hatched.events.map((event) => event.type)).toEqual(["pet.hatched", "achievement.unlocked"])
        const opened = yield* api.openSession({ payload: { sessionId: session } })
        expect(opened.snapshot.pet).toMatchObject({ species: "fox", name: "Pixel", form: 0 })
      }),
    ),
  )
})

describe("POST /v1/commands: band styles", () => {
  it.effect("equips an owned band style, keeps it across sessions, refuses the wrong slot, and unequips it", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        const sql = yield* SqlClient.SqlClient
        const entryId = "01K6ZQ8W3J0000000000009001"
        const entry = { id: entryId, itemId: "starlit-edge", acquiredAt: start, source: { kind: "drop", ref: "0" }, dye: null }
        yield* sql`UPDATE player_state SET state = jsonb_set(state, '{holdings,inventory}', ${JSON.stringify([entry])}::jsonb)`
        const wrong = yield* api.runCommand({ payload: { id: nextId(), type: "item.equip", data: { entryId, slot: "xpBar" } } })
        expect(wrong).toMatchObject({ status: "refused", code: "invalid" })
        const equipped = yield* api.runCommand({ payload: { id: nextId(), type: "item.equip", data: { entryId, slot: "topEdge" } } })
        const shown = equipped.status === "ok" && withoutQuests(equipped.events).map((one) => [one.type, one.data])
        expect(shown).toEqual([["item.equipped", { slot: "topEdge", entryId }]])
        const opened = yield* api.openSession({ payload: { sessionId: session } })
        expect(opened.snapshot.character.equipped).toEqual({ topEdge: entryId })
        const owned = opened.snapshot.items.filter((item) => item.id === "starlit-edge")
        expect(owned.map((item) => [item.id, item.look?.fps])).toEqual([["starlit-edge", 5]])
        const stream = yield* api.stream({ query: { after: 0 } })
        expect(withoutQuests(stream.events).map((event) => event.type)).toEqual(["item.equipped"])
        const unequipped = yield* api.runCommand({ payload: { id: nextId(), type: "item.unequip", data: { slot: "topEdge" } } })
        expect(unequipped.status).toBe("ok")
        expect((yield* api.openSession({ payload: { sessionId: session } })).snapshot.character.equipped).toEqual({})
      }),
    ),
  )
})

describe("GET /v1/stream", () => {
  it.effect("answers at once when the stream is past the cursor", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        const sent = yield* api.sendEvents({ payload: { events: [commit("a")] } })
        const stream = yield* api.stream({ query: { after: 1 } })
        expect(stream.events.map((event) => event.seq)).toEqual(sent.events.slice(1).map((event) => event.seq))
        expect(stream.cursor).toBe(sent.events.length)
        expect(stream.resync).toBeUndefined()
      }),
    ),
  )

  it.effect("holds the poll and wakes it when a commit adds events", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        const poll = yield* Effect.forkChild(api.stream({ query: { after: 0 } }))
        // Let the poll park on its 25-second timer, which the test clock never fires on its own.
        yield* untilAsleep(streamTimeout)
        const sent = yield* api.sendEvents({ payload: { events: [commit("a")] } })
        const stream = yield* Fiber.join(poll)
        expect(stream.events.map((event) => event.seq)).toEqual(sent.events.map((event) => event.seq))
      }),
    ),
  )

  it.effect("leaves a held poll alone when a resent batch adds nothing", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        const batch = { events: [commit("a")] }
        const sent = yield* api.sendEvents({ payload: batch })
        const cursor = sent.events.length
        const poll = yield* Effect.forkChild(api.stream({ query: { after: cursor } }))
        yield* untilAsleep(streamTimeout)
        yield* TestClock.adjust("1 second")
        yield* api.sendEvents({ payload: batch })
        yield* TestClock.adjust("1 second")
        expect(poll.pollUnsafe()).toBeUndefined()
        yield* TestClock.adjust("23 seconds")
        expect(yield* Fiber.join(poll)).toMatchObject({ events: [], cursor })
      }),
    ),
  )

  it.effect("answers with nothing after 25 seconds", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        const poll = yield* Effect.forkChild(api.stream({ query: { after: 0 } }))
        // Parked first: a clock moved while its reads still connect would time the connection out instead.
        yield* untilAsleep(streamTimeout)
        yield* TestClock.adjust("24 seconds")
        expect(poll.pollUnsafe()).toBeUndefined()
        yield* TestClock.adjust("1 second")
        const stream = yield* Fiber.join(poll)
        expect(stream).toMatchObject({ events: [], cursor: 0 })
      }),
    ),
  )

  it.effect("asks for a resync when the cursor is ahead of the stream", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        const stream = yield* api.stream({ query: { after: 5 } })
        expect(stream).toMatchObject({ events: [], cursor: 0, resync: true })
      }),
    ),
  )
})

/** Every row of every table, as Postgres prints it, so a read that changed a single byte anywhere shows. */
const everyRow = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const tables = yield* sql<{ readonly name: string }>`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
    ORDER BY 1
  `
  return yield* Effect.forEach(tables, ({ name }) =>
    Effect.map(sql<{ readonly row: string }>`SELECT t::text AS row FROM ${sql(name)} t ORDER BY 1`, (rows) => ({
      name,
      rows: rows.map(({ row }) => row),
    })))
})

describe("GET /v1/snapshot", () => {
  it.effect("answers what the session does, less the event types, and writes nothing however often it is asked", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        yield* api.sendEvents({ payload: { events: [commit("a"), prompt(8)] } })
        // A live session too, so a read that touched presence would show.
        const opened = yield* api.openSession({ payload: { sessionId: session, presence: true } })
        const before = yield* everyRow
        const watched = ["event_log", "player_state", "server_events", "sessions"]
        expect(before.map(({ name }) => name)).toEqual(expect.arrayContaining(watched))
        const read = yield* api.snapshot()
        const { acceptedEventTypes: _, ...sessionRead } = opened
        expect(read).toEqual(sessionRead)
        expect(read.snapshot.quests.length).toBeGreaterThan(0)
        yield* TestClock.adjust("1 minute")
        expect(yield* api.snapshot()).toEqual(read)
        expect(yield* everyRow).toEqual(before)
      }),
    ))

  it.effect("rolls no missions: a new day's come with the session, as before", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        const before = yield* everyRow
        const fresh = yield* api.snapshot()
        expect(fresh.snapshot.cursor).toBe(0)
        expect(fresh.snapshot.quests).toEqual([])
        expect(yield* everyRow).toEqual(before)
        const opened = yield* api.openSession({ payload: { sessionId: session } })
        expect(opened.snapshot.cursor).toBe(2)
        // The next day: the snapshot still shows the day the session rolled, and the next session rolls the new one.
        yield* TestClock.adjust("1 day")
        const nextDay = yield* everyRow
        expect((yield* api.snapshot()).snapshot.cursor).toBe(2)
        expect(yield* everyRow).toEqual(nextDay)
        expect((yield* api.openSession({ payload: { sessionId: session } })).snapshot.cursor).toBeGreaterThan(2)
      }),
    ))

  it.effect("answers 503 while a newer build saved the player, as the session does, and reads again after", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE player_state SET engine_version = ${engineVersion + 1}`
        const before = yield* everyRow
        expect((yield* Effect.flip(api.snapshot()))._tag).toBe("ServerBehind")
        expect((yield* Effect.flip(api.openSession({ payload: { sessionId: session } })))._tag).toBe("ServerBehind")
        expect(yield* everyRow).toEqual(before)
        yield* sql`UPDATE player_state SET engine_version = ${engineVersion}`
        expect((yield* api.snapshot()).snapshot.cursor).toBe(0)
      }),
    ))

  const ada = { id: 1, login: "Ada", name: "Ada Lovelace" }
  const bob = { id: 2, login: "bob", name: null }

  it.effect("on the public server, answers the signed-in player alone, and writes nothing", () =>
    Effect.gen(function* () {
      const handle = yield* publicWebHandler
      const asAda = yield* signIn(handle, ada)
      const asBob = yield* signIn(handle, bob)
      const opened = yield* handle(request("/v1/sessions", "POST", asAda.bearer, { sessionId: session }))
      expect(opened.status).toBe(200)
      const before = yield* everyRow
      const answered = yield* handle(request("/v1/snapshot", "GET", asAda.bearer))
      expect(answered.status).toBe(200)
      const read = yield* Schema.decodeUnknownEffect(SnapshotResponse)(yield* json(answered))
      expect(read.snapshot.player.id).toBe(asAda.player.id)
      expect(read.snapshot.cursor).toBe(2)
      expect(read.snapshot.serverId).toBe(`online-${asAda.player.id}`)
      const theirs = yield* handle(request("/v1/snapshot", "GET", asBob.bearer))
      const bobs = yield* Schema.decodeUnknownEffect(SnapshotResponse)(yield* json(theirs))
      expect(bobs.snapshot.player.id).toBe(asBob.player.id)
      expect(bobs.snapshot.cursor).toBe(0)
      expect((yield* handle(request("/v1/snapshot", "GET", null))).status).toBe(401)
      expect(yield* everyRow).toEqual(before)
    }).pipe(
      Effect.provide(
        testPublicServices({ signup: "open", allowedLogins: "", adminGithubIds: [] }, fakeGitHub([ada, bob])),
      ),
    ))
})
