import { it } from "@effect/vitest"
import { SnapshotResponse } from "@pathofdev/schema"
import { readFileSync, writeFileSync } from "node:fs"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import { client, commit, hatch, json, merged, request, session, start, webHandler, withServer } from "./fixtures.ts"

// `GET /v1/snapshot` as a contract between languages: the watcher that reads it is written in Rust, so its JSON on the
// wire is pinned in two files beside this test, which a client in any language can test against.
//
//   contract/snapshot-response.json         one answer, as a seeded local server gives it after a little play
//   contract/snapshot-response.schema.json  the JSON Schema (draft 2020-12) of every answer, from `SnapshotResponse`
//
// The schema is held exactly. The sample is held by its shape: every path in it and the JSON type found there, a map's
// keys as `*`, so a change to the rules' numbers or the catalog's items leaves it be, and a field added, dropped,
// renamed or retyped fails. Either failing is a change to the contract: run
// `PATHOFDEV_WRITE_CONTRACT=1 pnpm test snapshot-contract` to write both again, and say so in the PR, as every client
// reading the route has to follow.

const sampleFile = new URL("./contract/snapshot-response.json", import.meta.url)
const schemaFile = new URL("./contract/snapshot-response.schema.json", import.meta.url)
const writing = process.env["PATHOFDEV_WRITE_CONTRACT"] === "1"

const textOf = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`
const pinned = (file: URL): unknown => JSON.parse(readFileSync(file, "utf8"))

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const kindOf = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "array" : isRecord(value) ? "object" : typeof value

/** The branch of a JSON Schema node that describes a value of `kind`: itself, or the one of its `anyOf` that does. */
const branchOf = (schema: unknown, kind: string): Readonly<Record<string, unknown>> => {
  const node = isRecord(schema) ? schema : {}
  const branches = Array.isArray(node["anyOf"]) ? node["anyOf"].filter(isRecord) : [node]
  return branches.find((branch) => branch["type"] === kind) ?? node
}

/** The schema of a map's values, from `additionalProperties` or the first of its `patternProperties`. */
const valuesOf = (node: Readonly<Record<string, unknown>>): unknown => {
  const patterns = node["patternProperties"]
  return isRecord(node["additionalProperties"])
    ? node["additionalProperties"]
    : isRecord(patterns) ? Object.values(patterns)[0] : undefined
}

/** Every path in `value` and the JSON type there, walked by `schema`: an array's items as `[]`, a map's keys `*`. */
const shapeOf = (value: unknown, schema: unknown, path = "", into = new Set<string>()): Set<string> => {
  const kind = kindOf(value)
  into.add(`${path} ${kind}`)
  const node = branchOf(schema, kind)
  if (Array.isArray(value)) for (const item of value) shapeOf(item, node["items"], `${path}[]`, into)
  if (isRecord(value)) {
    const named = isRecord(node["properties"]) ? node["properties"] : {}
    for (const [key, field] of Object.entries(value)) {
      if (key in named) shapeOf(field, named[key], `${path}.${key}`, into)
      else shapeOf(field, valuesOf(node), `${path}.*`, into)
    }
  }
  return into
}

const sorted = (shape: Set<string>): Array<string> => [...shape].sort()

/** Every input the sample's play sends, with ids of its own, so the answer is the same whatever ran before. */
const ids = {
  commit: "01K6ZQ8W3J0000000000007001",
  merged: "01K6ZQ8W3J0000000000007002",
  hatch: "01K6ZQ8W3J0000000000007003",
}

/**
 * The answer, as the bytes on the wire read back: a player who committed, merged, opened a session (which rolled the
 * day's missions) and hatched their pet, so the sample has a pet, missions, XP, gold and badges to show.
 */
const sampleAnswer = Effect.gen(function* () {
  const api = yield* client
  yield* api.sendEvents({ payload: { events: [commit("contract", start, ids.commit), merged(1, ids.merged)] } })
  yield* api.openSession({ payload: { sessionId: session } })
  yield* api.runCommand({ payload: hatch(ids.hatch) })
  const handle = yield* webHandler
  const response = yield* handle(request("/v1/snapshot", "GET", null))
  expect(response.status).toBe(200)
  const body: unknown = yield* json(response)
  return body
})

describe("the GET /v1/snapshot contract", () => {
  it.effect("answers in the shape contract/snapshot-response.json holds", () =>
    withServer(
      Effect.gen(function* () {
        const answer = yield* sampleAnswer
        if (writing) writeFileSync(sampleFile, textOf(answer))
        const schema = pinned(schemaFile)
        expect(sorted(shapeOf(answer, schema))).toEqual(sorted(shapeOf(pinned(sampleFile), schema)))
      }),
      undefined,
      false,
      "snapshot-contract",
    ))

  it("pins a sample that is an answer: it decodes, and encodes back to itself", () => {
    const sample = pinned(sampleFile)
    const decoded = Schema.decodeUnknownSync(SnapshotResponse)(sample)
    expect(Schema.encodeSync(SnapshotResponse)(decoded)).toEqual(sample)
    // The sample shows each kind of value the clients must read: a pet and no egg, missions, badges and items.
    expect(decoded.snapshot.pet).not.toBeNull()
    expect(decoded.snapshot.egg).toBeNull()
    expect(decoded.snapshot.quests.length).toBeGreaterThan(0)
    expect(decoded.snapshot.achievements.length).toBeGreaterThan(0)
    expect(decoded.snapshot.items.length).toBeGreaterThan(0)
    expect(decoded.snapshot.dev).toBeUndefined()
  })

  it("describes every answer as contract/snapshot-response.schema.json does", () => {
    const document = Schema.toJsonSchemaDocument(SnapshotResponse)
    // A file any JSON Schema validator reads alone. Objects stay open to fields they don't name, as the decoders are:
    // a client ignores a field it doesn't know, which is how a newer server adds one.
    const standalone = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "GET /v1/snapshot",
      ...document.schema,
      ...(Object.keys(document.definitions).length === 0 ? {} : { $defs: document.definitions }),
    }
    if (writing) writeFileSync(schemaFile, textOf(standalone))
    expect(standalone).toEqual(pinned(schemaFile))
  })
})
