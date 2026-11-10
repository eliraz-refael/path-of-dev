import { it } from "@effect/vitest"
import type { ChangeMerged, CommitMade, SeasonView } from "@pathofdev/schema"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import { client, nextId, session, withServer } from "./fixtures.ts"

// Season 1 over the routes, on the server's own clock: it begins at the player's local midnight on 26 November and
// ends at the one after 24 January, wherever they are; play dated inside it still counts for the week the edge takes
// late events, and then it is over. The zones are the first to start, Israel's, and the last. Each test starts its
// server's clock at the moment it looks at, as the background loops would wake every 30 seconds of a jump of weeks.

const zones = [
  { timezone: "Pacific/Kiritimati", startsAt: "2026-11-25T10:00:00.000Z", endsAt: "2027-01-24T10:00:00.000Z" },
  { timezone: "Asia/Jerusalem", startsAt: "2026-11-25T22:00:00.000Z", endsAt: "2027-01-24T22:00:00.000Z" },
  { timezone: "Pacific/Pago_Pago", startsAt: "2026-11-26T11:00:00.000Z", endsAt: "2027-01-25T11:00:00.000Z" },
] as const

const minute = 60_000
const day = 24 * 60 * minute

/** `instant` moved by `ms`. */
const plus = (instant: string, ms: number): string => new Date(Date.parse(instant) + ms).toISOString()

let shas = 0
/** A commit at `occurredAt`, each with a sha of its own: 3 XP. */
const commitAt = (occurredAt: string): typeof CommitMade.Type => ({
  id: nextId(),
  type: "commit.made",
  occurredAt,
  sessionId: session,
  data: {
    commit: { type: "github", repo: "acme/seasons", sha: (++shas).toString(16).padStart(40, "0"), key: "c".repeat(64) },
  },
})

let changes = 0
/** A merge at `occurredAt`, each a change of its own: 250 XP. */
const mergeAt = (occurredAt: string): typeof ChangeMerged.Type => ({
  id: nextId(),
  type: "change.merged",
  occurredAt,
  sessionId: session,
  data: { change: { type: "github", repo: "acme/seasons", number: 1000 + ++changes, key: "d".repeat(64) } },
})

/** The test clock set to `instant`, which it returns. */
const clockAt = (instant: string) => Effect.as(TestClock.setTime(Date.parse(instant)), instant)

const season = Effect.gen(function* () {
  const api = yield* client
  return (yield* api.snapshot()).snapshot.season
})

describe("Season 1 over the routes", () => {
  for (const { timezone, startsAt, endsAt } of zones) {
    it.effect(`starts at the local midnight of 26 November in ${timezone}`, () =>
      withServer(
        Effect.gen(function* () {
          const api = yield* client
          // A minute before: upcoming, and a merge counts nothing toward the pass.
          yield* api.sendEvents({ payload: { events: [mergeAt(plus(startsAt, -minute))] } })
          expect(yield* season).toMatchObject({ id: "s1", status: "upcoming", startsAt, endsAt, xp: 0, tier: 0 })

          // A minute after: running, and the first day counts double, two merges to its cap of 300.
          const first = yield* clockAt(plus(startsAt, minute))
          const sent = yield* api.sendEvents({ payload: { events: [mergeAt(first), mergeAt(first)] } })
          expect(yield* season).toMatchObject({
            status: "running",
            xp: 600,
            tier: 3,
            today: { pass: 300, cap: 300, doubled: true },
          })
          const banners = sent.events.flatMap((event) => (event.type === "season.tier" ? [event.data.to] : []))
          expect(banners).toEqual([2, 3])
          const gold = sent.events.find((event) => event.type === "gold.changed" && event.data.reason === "season")
          expect(gold).toMatchObject({ data: { delta: 100 } })
          const { inventory } = (yield* api.snapshot()).snapshot
          expect(inventory.flatMap((entry) => (entry.source.kind === "season" ? [entry.source.ref] : []))).toEqual([
            "s1/2",
            "s1/3",
          ])
        }),
        undefined,
        false,
        undefined,
        { timezone, now: plus(startsAt, -minute) },
      ))

    it.effect(`ends at the local midnight after 24 January in ${timezone}, and settles for a week`, () =>
      withServer(
        Effect.gen(function* () {
          const api = yield* client
          // A minute before the last day ends: a commit counts, doubled, as the day before had no play.
          yield* api.sendEvents({ payload: { events: [commitAt(plus(endsAt, -minute))] } })
          const last: SeasonView | undefined = yield* season
          expect(last).toMatchObject({ status: "running", today: { doubled: true } })
          const counted = last?.today.pass ?? 0
          expect(counted).toBeGreaterThan(0)
          expect(last?.xp).toBe(2 * counted)

          // Past the end: settling. A merge today counts nothing; one made on the last day, arriving late, still does.
          const after = yield* clockAt(plus(endsAt, minute))
          yield* api.sendEvents({ payload: { events: [mergeAt(after)] } })
          expect(yield* season).toMatchObject({ status: "settling", xp: 2 * counted, today: { pass: 0 } })
          yield* api.sendEvents({ payload: { events: [mergeAt(plus(endsAt, -30 * minute))] } })
          expect(yield* season).toMatchObject({ status: "settling", xp: 2 * (counted + 250), tier: 2 })
        }),
        undefined,
        false,
        undefined,
        { timezone, now: plus(endsAt, -minute) },
      ))

    it.effect(`is over a week after the end in ${timezone}, when play dated inside it is too old to arrive`, () =>
      withServer(
        Effect.gen(function* () {
          const api = yield* client
          expect(yield* season).toMatchObject({ status: "settling" })
          const over = yield* clockAt(plus(endsAt, 7 * day + minute))
          const late = yield* api.sendEvents({ payload: { events: [mergeAt(plus(endsAt, -30 * minute))] } })
          expect(late.results.map((result) => result.status)).toEqual(["rejected"])
          yield* api.sendEvents({ payload: { events: [mergeAt(over)] } })
          expect(yield* season).toMatchObject({ status: "over", xp: 0, tier: 0 })
        }),
        undefined,
        false,
        undefined,
        { timezone, now: plus(endsAt, 7 * day - minute) },
      ))
  }
})
