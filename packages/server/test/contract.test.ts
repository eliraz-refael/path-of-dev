import { it } from "@effect/vitest"
import type { CommandResponse, ServerEvent } from "@pathofdev/schema"
import { SnapshotResponse, StreamResponse } from "@pathofdev/schema"
import { readFileSync, writeFileSync } from "node:fs"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import {
  client,
  commit,
  hatch,
  json,
  merged,
  prompt,
  request,
  session,
  start,
  webHandler,
  withServer,
} from "./fixtures.ts"

// The answers the companion (crates/pathofdev, in Rust) reads, written here from a real server's play into contract/,
// where its contract test decodes them and holds every field it skips to contract/unread.txt:
//
//   contract/snapshot.json        GET /v1/snapshot for a player who has played: a pet that grew, a sigil worn, missions
//                                  running and done, so every field the companion draws is carried
//   contract/stream.json          GET /v1/stream from the start: an answer holding each event the companion draws
//   contract/stream-resync.json   GET /v1/stream with a cursor ahead of the stream: a resync
//
// snapshot-contract.test.ts pins the plain player's snapshot, with its JSON Schema, for a client in any language; the
// companion reads that one too. The server is seeded and its clock fixed, so the play answers the same bytes each run:
// a file that differs means the answers changed. Run `pnpm contract` to write them all again, and run the Rust tests
// (`cargo test`), which fail until the companion reads the new fields or lists them as unread.

const writing = process.env["PATHOFDEV_WRITE_CONTRACT"] === "1"
const contract = new URL("../../../contract/", import.meta.url)

const textOf = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

/** Writes `value` to `name` under contract/ when writing, else holds it equal to the committed file. */
const pin = (name: string, value: unknown) => {
  const file = new URL(name, contract)
  if (writing) writeFileSync(file, textOf(value))
  expect(textOf(value), `contract/${name} is out of date: run pnpm contract`).toBe(readFileSync(file, "utf8"))
}

/** Every input the play sends, with ids of its own, so the answers are the same whatever ran before. */
const ids = {
  commit: "01K6ZQ8W3J0000000000008001",
  merged: "01K6ZQ8W3J0000000000008002",
  hatch: "01K6ZQ8W3J0000000000008003",
  grant: "01K6ZQ8W3J0000000000008004",
  equip: "01K6ZQ8W3J0000000000008005",
  prompts: ["01K6ZQ8W3J0000000000008006", "01K6ZQ8W3J0000000000008007"],
  xp: "01K6ZQ8W3J0000000000008009",
  accept: "01K6ZQ8W3J000000000000800A",
  complete: "01K6ZQ8W3J000000000000800B",
}

/** The event types the companion draws: the stream fixture carries each, so a rename on either side fails a test. */
const drawn = [
  "xp.granted",
  "level.up",
  "loot.dropped",
  "quest.progress",
  "quest.completed",
  "achievement.unlocked",
  "pet.hatched",
]

/** The events of a command the server took, or the test fails with its reason. */
const taken = (type: string, answer: CommandResponse): ReadonlyArray<ServerEvent> => {
  if (answer.status !== "ok") throw new Error(`${type} was refused: ${answer.message}`)
  return answer.events
}

/**
 * The play, on a dev server, whose commands reach what play would take days to: a commit and a merge, a session (which
 * rolls the missions), the pet hatched, a sigil granted and worn, two prompts graded well (short of the dailies they
 * move), a level's worth of XP, a weekly picked and a daily finished. Then the three answers, as the bytes on the wire
 * read back.
 */
const play = Effect.gen(function* () {
  const api = yield* client
  yield* api.sendEvents({ payload: { events: [commit("contract", start, ids.commit), merged(1, ids.merged)] } })
  const opened = yield* api.openSession({ payload: { sessionId: session } })
  const weekly = opened.snapshot.quests.find((quest) => quest.cadence === "weekly" && quest.status === "offered")
  if (weekly === undefined) throw new Error("no weekly on offer")
  taken("pet.hatch", yield* api.runCommand({ payload: hatch(ids.hatch) }))
  const granted = taken(
    "dev.grantItem",
    yield* api.runCommand({ payload: { id: ids.grant, type: "dev.grantItem", data: { itemId: "arcane-sigil" } } }),
  )
  const drop = granted.find((event) => event.type === "loot.dropped")
  if (drop?.type !== "loot.dropped") throw new Error("the sigil never dropped")
  taken(
    "item.equip",
    yield* api.runCommand({
      payload: { id: ids.equip, type: "item.equip", data: { entryId: drop.data.entry.id, slot: "sigil" } },
    }),
  )
  yield* api.sendEvents({ payload: { events: ids.prompts.map((id) => prompt(9, id)) } })
  taken("dev.grantXp", yield* api.runCommand({ payload: { id: ids.xp, type: "dev.grantXp", data: { amount: 25000 } } }))
  taken(
    "quest.accept",
    yield* api.runCommand({ payload: { id: ids.accept, type: "quest.accept", data: { questId: weekly.questId } } }),
  )
  // A daily the prompts left untouched is finished, so one they moved stays running.
  const idle = (yield* api.openSession({ payload: { sessionId: session } })).snapshot.quests.find(
    (quest) => quest.cadence === "daily" && quest.status === "active" && quest.progress === 0,
  )
  if (idle === undefined) throw new Error("no daily to finish")
  taken(
    "dev.completeQuest",
    yield* api.runCommand({
      payload: { id: ids.complete, type: "dev.completeQuest", data: { questId: idle.questId } },
    }),
  )

  const handle = yield* webHandler
  const read = (path: string) =>
    Effect.gen(function* () {
      const response = yield* handle(request(path, "GET", null))
      expect({ path, status: response.status }).toEqual({ path, status: 200 })
      const body: unknown = yield* json(response)
      return body
    })
  const snapshot = yield* read("/v1/snapshot")
  const stream = yield* read("/v1/stream?after=0")
  // A cursor past the stream's end, as a client of another server or a reset one would send.
  const ahead = Schema.decodeUnknownSync(SnapshotResponse)(snapshot).snapshot.cursor + 1
  const resync = yield* read(`/v1/stream?after=${ahead}`)
  return { snapshot, stream, resync }
})

describe("the answers the companion reads", () => {
  it.effect("are the ones contract/ holds", () =>
    withServer(
      Effect.gen(function* () {
        const { snapshot, stream, resync } = yield* play

        const decoded = Schema.decodeUnknownSync(SnapshotResponse)(snapshot)
        // The snapshot shows what Home draws: a pet past its first form, a sigil worn, missions running.
        expect(decoded.snapshot.pet?.form).toBeGreaterThan(0)
        expect(decoded.snapshot.character.equipped["sigil"]).toBeDefined()
        expect(decoded.snapshot.items.some((item) => item.sigil !== undefined)).toBe(true)
        expect(decoded.snapshot.quests.some((quest) => quest.status === "active" && quest.progress > 0)).toBe(true)
        pin("snapshot.json", snapshot)

        const events = Schema.decodeUnknownSync(StreamResponse)(stream).events
        expect([...new Set(events.map((event) => event.type))]).toEqual(expect.arrayContaining(drawn))
        // A graded prompt's grant, priced with the sigil worn.
        const graded = events.flatMap((event) =>
          event.type === "xp.granted" && event.data.reason === "prompt.graded" ? [event.data] : []
        )
        expect(graded.some((grant) => grant.grade !== undefined && grant.sigil !== undefined)).toBe(true)
        pin("stream.json", stream)

        expect(Schema.decodeUnknownSync(StreamResponse)(resync)).toMatchObject({ events: [], resync: true })
        pin("stream-resync.json", resync)
      }),
      undefined,
      true,
      "contract",
    ))
})
