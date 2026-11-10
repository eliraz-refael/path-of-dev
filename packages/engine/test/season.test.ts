import { it } from "@effect/vitest"
import type {
  ClientEvent,
  Context,
  Input,
  PlayerState,
  QuestDef,
  QuestPack,
  RollRecord,
  RulesConfig,
  Step,
} from "@pathofdev/schema"
import {
  PlayerState as PlayerStateSchema,
  RulesConfig as RulesSchema,
  Season as SeasonSchema,
  seasonIssue,
  Snapshot as SnapshotSchema,
} from "@pathofdev/schema"
import { readFileSync } from "node:fs"
import { Schema } from "effect"
import { describe, expect } from "vitest"
import {
  addDays,
  initialState,
  isRested,
  passedOf,
  project,
  rules16,
  season1,
  seasonShown,
  starterCatalog,
  starterRules,
  step,
} from "../src/index.ts"
import { client, flat, nextId, session } from "./play.ts"

// Season 1 and its pass, the kernel: the rules data, frozen once it starts; the pass a function of the days played,
// whatever order their events arrive in; its tiers granted once; the snapshot's view of it; a replay across the start,
// the end and the settle; and the pacing the plan promised, played through `step`.

const zone = "UTC"

/** An instant on local day `day`, `minutes` after 09:00 in UTC. */
const at = (day: string, minutes = 0): string =>
  new Date(Date.parse(`${day}T09:00:00Z`) + minutes * 60_000).toISOString()

/** An event of `type` at `occurredAt`, its data varied by `n` as play.ts does. */
const event = (type: ClientEvent["type"], occurredAt: string, n = 5): Input => {
  const input = client(type, 0, session, n)
  return input.kind === "client" ? { kind: "client", event: { ...input.event, occurredAt } } : input
}

/** A rubric 1 prompt graded `grade` on every score, 2 XP a point in the day's first band. */
const prompt = (occurredAt: string, grade = 5.5): Input => ({
  kind: "client",
  event: {
    id: nextId(),
    occurredAt,
    sessionId: session,
    type: "prompt.graded",
    data: { scores: flat(grade), rubricVersion: 1, words: 12, grader: "haiku" },
  },
})

const accept = (questId: string): Input => ({
  kind: "command",
  command: { id: nextId(), type: "quest.accept", data: { questId } },
})

/** A log row: its input, and when the server received it. */
interface Row {
  readonly input: Input
  readonly now: string
}

/** A client event's row, received when it happened or `late` days after; a command's row names its own time. */
const row = (input: Input, late = 0): Row => {
  if (input.kind !== "client") throw new Error("a command's row names when it came")
  return { input, now: new Date(Date.parse(input.event.occurredAt) + late * 86_400_000).toISOString() }
}

const fresh = (timezone = zone): PlayerState =>
  initialState({ characterName: "Player", timezone, now: "2026-11-01T00:00:00.000Z" })

const contextOf = (
  logSeq: number,
  now: string,
  rules: RulesConfig,
  questPacks: ReadonlyArray<QuestPack>,
  mode: Context["mode"] = { kind: "live" },
  dev = false,
): Context => ({ now, logSeq, rollSeed: "season-seed", rules, catalog: starterCatalog, questPacks, mode, dev })

/** Rows through `step`, as the write path runs them. */
const live = (
  rows: ReadonlyArray<Row>,
  rules = starterRules,
  packs: ReadonlyArray<QuestPack> = [],
  state = fresh(),
) => {
  const steps: Array<Step> = []
  for (const [i, { input, now }] of rows.entries()) {
    const result = step(state, input, contextOf(i + 1, now, rules, packs))
    steps.push(result)
    state = result.state
  }
  return { state, steps }
}

/** The same rows replayed from the rolls and refusals the live run recorded. */
const replayed = (rows: ReadonlyArray<Row>, steps: ReadonlyArray<Step>, packs: ReadonlyArray<QuestPack> = []) => {
  let state = fresh()
  const events = []
  for (const [i, { input, now }] of rows.entries()) {
    const recorded = { rolls: steps[i]?.rolls ?? [], refusal: steps[i]?.refusal ?? null }
    const result = step(state, input, contextOf(i + 1, now, starterRules, packs, { kind: "replay", recorded }))
    events.push(...result.events)
    state = result.state
  }
  return { state, events }
}

/** A day of work that earns well past the cap: two merges of 250 and a commit. */
const busy = (day: string): Array<Row> => [
  row(event("change.merged", at(day), 10)),
  row(event("change.merged", at(day, 1), 10)),
  row(event("commit.made", at(day, 2))),
]

const passOf = (state: PlayerState) => passedOf(state, "s1")

const tallyOf = (state: PlayerState, day: string) => state.progress.tallies.find((tally) => tally.day === day)

/** What the server tells `project` of the player and the stream. */
const meta = {
  player: { id: session, githubUserId: null, githubLogin: null, displayName: "Player", createdAt: at("2026-11-01") },
  serverId: "local-test",
  streamEpoch: 1,
  cursor: 0,
}

const snapshotOf = (state: PlayerState, now: string) =>
  project(state, { rules: starterRules, catalog: starterCatalog, questPacks: [], now }, meta)

describe("Season 1: Trailhead", () => {
  it("runs 60 local days, Thursday 26 November to Sunday 24 January, in 30 tiers that make 18,000", () => {
    expect([season1.id, season1.name, season1.startsOn, season1.endsOn]).toEqual([
      "s1",
      "Season 1: Trailhead",
      "2026-11-26",
      "2027-01-24",
    ])
    expect(addDays(season1.startsOn, 59)).toBe(season1.endsOn)
    expect(new Date(`${season1.startsOn}T00:00:00Z`).getUTCDay()).toBe(4)
    const { pass } = season1
    expect([pass.perDay, pass.rested.factor, pass.missions, pass.beyond]).toEqual([
      300,
      2,
      { daily: 30, weekly: 120 },
      { xp: 1000, gold: 100 },
    ])
    expect(pass.tiers.map((tier) => tier.xp)).toEqual([...Array(5).fill(200), ...Array(25).fill(680)])
    expect(pass.tiers.reduce((sum, tier) => sum + tier.xp, 0)).toBe(18_000)
    // Gold every fifth tier from the first, 1,750 in all, and something at every tier.
    expect(pass.tiers.flatMap((tier, i) => (tier.gold === undefined ? [] : [[i + 1, tier.gold]]))).toEqual([
      [1, 100],
      [6, 150],
      [11, 200],
      [16, 250],
      [21, 300],
      [26, 350],
      [29, 400],
    ])
    expect(starterRules.seasons).toEqual([season1])
  })

  it("names its five exclusives, none in the catalogue yet, and only catalogue items that are no sigil", () => {
    const exclusives = season1.pass.tiers.flatMap((tier, i) => (tier.exclusive ? [[i + 1, tier.exclusive.id]] : []))
    expect(exclusives).toEqual([
      [8, "trailhead"],
      [15, "pathfinders-hat"],
      [20, "summit-banner"],
      [25, "switchback-edge"],
      [30, "summit-at-dawn"],
    ])
    expect(seasonIssue([season1], starterCatalog)).toBeUndefined()
    const items = season1.pass.tiers.flatMap((tier) => tier.items ?? [])
    expect(items).toHaveLength(18)
    for (const id of items) {
      const item = starterCatalog.find((def) => def.id === id)
      expect(item?.sigil, id).toBeUndefined()
      expect(item?.rarity, id).not.toBe("legendary")
    }
    expect(Schema.decodeUnknownSync(RulesSchema)(starterRules)).toEqual(starterRules)
  })

  it("is frozen: fixtures/season-1.json holds it, and only a later last day may differ", () => {
    const file = new URL("./fixtures/season-1.json", import.meta.url)
    const pinned = Schema.decodeUnknownSync(SeasonSchema)(JSON.parse(readFileSync(file, "utf8")))
    expect({ ...season1, endsOn: pinned.endsOn }).toEqual(pinned)
    expect(season1.endsOn >= pinned.endsOn).toBe(true)
  })

  it("refuses a season that ends before it starts, seasons that overlap, and a tier with no reward", () => {
    const decode = Schema.decodeUnknownExit(RulesSchema)
    const withSeasons = (seasons: unknown): unknown => ({ ...starterRules, seasons })
    expect(decode(withSeasons([{ ...season1, endsOn: "2026-11-01" }]))._tag).toBe("Failure")
    expect(decode(withSeasons([season1, { ...season1, id: "s2", endsOn: "2027-02-01" }]))._tag).toBe("Failure")
    expect(decode(withSeasons([season1, { ...season1, startsOn: "2027-02-01", endsOn: "2027-03-01" }]))._tag).toBe(
      "Failure",
    )
    const bare = { ...season1, pass: { ...season1.pass, tiers: [{ xp: 200 }] } }
    expect(decode(withSeasons([bare]))._tag).toBe("Failure")
    expect(decode(withSeasons([season1, { ...season1, id: "s2", startsOn: "2027-02-01", endsOn: "2027-03-01" }]))._tag)
      .toBe("Success")
  })
})

describe("the pass", () => {
  it("counts nothing before the season: a log from before it runs under rules 17 as under rules 16", () => {
    const days = ["2026-11-18", "2026-11-19", "2026-11-21", "2026-11-25"]
    const rows = days.flatMap((day) => [
      ...busy(day),
      row(prompt(at(day, 3))),
      row(event("repo.explored", at(day, 4))),
      row(event("tests.failed", at(day, 5))),
      row(event("tests.passed", at(day, 6))),
    ])
    const before = live(rows, rules16)
    const now = live(rows, starterRules)
    const unversioned = (rolls: ReadonlyArray<RollRecord>) => rolls.map(({ rulesVersion: _v, ...roll }) => roll)
    for (const [i, one] of now.steps.entries()) {
      const then = before.steps[i]
      expect(one.events).toEqual(then?.events)
      expect(unversioned(one.rolls)).toEqual(unversioned(then?.rolls ?? []))
      expect(one.state).toEqual(then?.state)
    }
    expect(now.state.holdings.seasons).toBeUndefined()
    expect(now.state.progress.tallies.every((tally) => !Object.hasOwn(tally, "pass"))).toBe(true)
  })

  it("fills up to 300 a local day, doubled on the first day and on a day after one without play", () => {
    const first = live(busy("2026-11-26"))
    expect(tallyOf(first.state, "2026-11-26")?.pass).toBe(300)
    expect(passOf(first.state)).toEqual({ id: "s1", xp: 600, tier: 3 })
    const next = live([...busy("2026-11-26"), ...busy("2026-11-27")])
    expect(passOf(next.state)).toEqual({ id: "s1", xp: 900, tier: 4 })
    // Saturday off: Sunday counts double.
    const rested = live([...busy("2026-11-26"), ...busy("2026-11-27"), ...busy("2026-11-29")])
    expect(passOf(rested.state)).toEqual({ id: "s1", xp: 1500, tier: 5 })
    // A light day counts what it earned, doubled after a day off.
    const light = live([row(event("commit.made", at("2026-11-26")))])
    const earned = light.steps[0]?.events.flatMap((one) => (one.type === "xp.granted" ? [one.data.amount] : []))
    expect(passOf(light.state).xp).toBe(2 * (earned ?? []).reduce((sum, amount) => sum + amount, 0))
  })

  it("takes the double off the day after a rest day that a late event fills, and takes no tier back", () => {
    const rows = [...busy("2026-11-26"), ...busy("2026-11-28")]
    const before = live(rows)
    expect(passOf(before.state)).toEqual({ id: "s1", xp: 1200, tier: 5 })
    // A commit made on Friday the 27th arrives on Sunday: Friday counts once, and Saturday no longer follows a day off.
    const late = live([...rows, row(event("commit.made", at("2026-11-27")), 2)])
    const friday = tallyOf(late.state, "2026-11-27")?.pass ?? 0
    expect(friday).toBeGreaterThan(0)
    expect(passOf(late.state)).toEqual({ id: "s1", xp: 600 + friday + 300, tier: 5 })
    expect(late.steps.at(-1)?.events.some((one) => one.type === "season.tier")).toBe(false)
  })

  it("counts no dev XP and no carried XP", () => {
    const day = "2026-11-26"
    const played = live([row(event("commit.made", at(day)))])
    const xp = passOf(played.state).xp
    const grant: Input = { kind: "command", command: { id: nextId(), type: "dev.grantXp", data: { amount: 5000 } } }
    const dev = step(played.state, grant, contextOf(2, at(day, 1), starterRules, [], { kind: "live" }, true))
    expect(dev.refusal).toBeNull()
    expect(dev.state.progress.xp.reported).toBeGreaterThan(played.state.progress.xp.reported)
    expect(passOf(dev.state).xp).toBe(xp)
    const carried: Input = { kind: "system", event: { type: "xp.carried", amount: 5000, rulesVersion: 17 } }
    const carry = step(dev.state, carried, contextOf(3, at(day, 2), starterRules, []))
    expect(passOf(carry.state).xp).toBe(xp)
  })

  it("adds a mission's bonus on the day it completes, whatever day its window began", () => {
    // A weekly picked on Monday 23 November, before the season, and finished on Friday the 27th, inside it.
    const rows = [
      row(event("commit.made", at("2026-11-23"))),
      { input: accept("commits-week"), now: at("2026-11-23", 1) },
      ...[0, 1].map((n) => row(event("commit.made", at("2026-11-24", n)))),
      ...[0, 1, 2, 3].map((n) => row(event("commit.made", at("2026-11-27", n)))),
    ]
    const { state, steps } = live(rows, starterRules, [pace])
    const completed = (one: Step) => one.events.flatMap((e) => (e.type === "quest.completed" ? [e.data.questId] : []))
    const completedOn = (day: string) => steps.flatMap((one, i) => (rows[i]?.now.startsWith(day) ? completed(one) : []))
    expect(completedOn("2026-11-23")).toEqual(["a-commit"])
    expect(completedOn("2026-11-27")).toEqual(["a-commit", "commits-week"])
    // Friday follows Thursday without play, so it counts double; its two missions add 30 and 120 on top.
    // Its XP counts toward the day's cap too: 4 commits, the streak, and the two missions' 45 and 150.
    const friday = tallyOf(state, "2026-11-27")?.pass ?? 0
    expect(friday).toBe(12 + 10 + 45 + 150)
    expect(passOf(state).xp).toBe(2 * friday + 30 + 120)
  })

  it("counts nothing after the last day, but play dated inside it while the season settles", () => {
    const last = live([...busy("2027-01-23"), ...busy("2027-01-25")])
    // The 23rd follows a day without play, as the log begins on it.
    expect(passOf(last.state).xp).toBe(600)
    const settled = live([...busy("2027-01-23"), row(event("commit.made", at("2027-01-24")), 3)])
    expect(tallyOf(settled.state, "2027-01-24")?.pass).toBeGreaterThan(0)
    expect(passOf(settled.state).xp).toBe(600 + (tallyOf(settled.state, "2027-01-24")?.pass ?? 0))
  })

  // A day's events in any order: the same value, never above 300 × 2.
  const DayEvent = Schema.Struct({
    kind: Schema.Literals(["commit.made", "repo.explored", "change.merged", "prompt.graded"]),
    n: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 })),
    key: Schema.Finite,
  })
  it.prop(
    "gives a local day the same value whatever order its events come in",
    [Schema.Array(DayEvent).check(Schema.isMaxLength(40))],
    ([events]) => {
      const day = "2026-12-02"
      const inputs = (order: ReadonlyArray<typeof DayEvent.Type>) =>
        order.map((one, i) =>
          row(one.kind === "prompt.graded" ? prompt(at(day, i), 6) : event(one.kind, at(day, i), one.n)),
        )
      const shuffled = [...events].sort((a, b) => a.key - b.key)
      const a = live(inputs(events))
      const b = live(inputs(shuffled))
      expect(passOf(a.state)).toEqual(passOf(b.state))
      expect(passOf(a.state).xp).toBeLessThanOrEqual(season1.pass.perDay * season1.pass.rested.factor)
    },
  )

  // Events over two weeks around the start, each arriving up to 6 days late, in the order they arrive.
  const Late = Schema.Struct({
    day: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 16 })),
    kind: Schema.Literals(["commit.made", "repo.explored", "change.merged", "prompt.graded"]),
    late: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })),
  })
  it.prop(
    "keeps the counter at the value of the days played, whatever order they arrive in, and grants each tier once",
    [Schema.Array(Late).check(Schema.isMaxLength(80))],
    ([script]) => {
      const rows = script
        .map((one, i) => {
          const occurredAt = at(addDays("2026-11-20", one.day), i)
          const input = one.kind === "prompt.graded" ? prompt(occurredAt) : event(one.kind, occurredAt, 10)
          return row(input, one.late)
        })
        .sort((a, b) => Date.parse(a.now) - Date.parse(b.now))
      const { state, steps } = live(rows)
      // Every tally and active day as it last stood: a day stops changing once the tallies drop it.
      const pass = new Map<string, number>()
      const active = new Set<string>()
      let tier = 0
      const reached: Array<number> = []
      for (const one of steps) {
        for (const tally of one.state.progress.tallies) pass.set(tally.day, tally.pass ?? 0)
        for (const day of one.state.progress.activeDays) active.add(day)
        const now = passOf(one.state).tier
        expect(now).toBeGreaterThanOrEqual(tier)
        tier = now
        for (const e of one.events) {
          if (e.type !== "season.tier") continue
          for (let t = e.data.from + 1; t <= e.data.to; t++) reached.push(t)
        }
      }
      const days = [...active].sort()
      const value = [...pass.entries()]
        .filter(([day]) => day >= season1.startsOn && day <= season1.endsOn)
        .reduce((sum, [day, counted]) => sum + counted * (isRested(season1, days, day) ? 2 : 1), 0)
      expect(passOf(state).xp).toBe(value)
      expect(reached).toEqual(Array.from({ length: tier }, (_, i) => i + 1))
      const seasonal = state.holdings.inventory.filter((entry) => entry.source.kind === "season")
      expect(new Set(seasonal.map((entry) => entry.source.ref)).size).toBe(seasonal.length)
    },
  )

  it("grants each tier's gold, then its items as named drops, and the tiers reached together as one banner", () => {
    const rows = [...busy("2026-11-26"), ...busy("2026-11-27"), ...busy("2026-11-29")]
    const { state, steps } = live(rows)
    const banners = steps.flatMap((one) => one.events.filter((e) => e.type === "season.tier"))
    expect(banners.map((e) => e.type === "season.tier" && [e.data.from, e.data.to, e.data.rewards])).toEqual([
      [0, 2, { gold: 100, items: ["sugar-plum"], exclusives: [] }],
      [2, 3, { gold: 0, items: ["kite-hill"], exclusives: [] }],
      [3, 4, { gold: 0, items: ["trail-mix"], exclusives: [] }],
      [4, 5, { gold: 0, items: ["rope-rule"], exclusives: [] }],
    ])
    const seasonal = state.holdings.inventory.filter((entry) => entry.source.kind === "season")
    expect(seasonal.map((entry) => [entry.itemId, entry.source.ref])).toEqual([
      ["sugar-plum", "s1/2"],
      ["kite-hill", "s1/3"],
      ["trail-mix", "s1/4"],
      ["rope-rule", "s1/5"],
    ])
    // The first merge reaches tiers 1 and 2 together: one banner, then tier 1's gold, then tier 2's drop, the step's
    // last roll.
    const tiered = steps.find((one) => one.events.some((e) => e.type === "season.tier" && e.data.to === 2))
    const types = tiered?.events.map((e) => e.type) ?? []
    const banner = types.indexOf("season.tier")
    expect(types.slice(banner, banner + 3)).toEqual(["season.tier", "gold.changed", "loot.dropped"])
    expect(tiered?.events[banner + 1]).toMatchObject({ data: { delta: 100, reason: "season" } })
    expect(tiered?.rolls.at(-1)).toMatchObject({ trigger: "reward", chance: 1, drop: { itemId: "sugar-plum" } })
  })

  it("names an exclusive in its tier's banner and grants nothing for it while the catalogue lacks it", () => {
    // 600 on the first day, then 300 a day: tier 8, at 3,040, on the tenth.
    const days = Array.from({ length: 10 }, (_, i) => addDays("2026-11-26", i))
    const { state, steps } = live(days.flatMap(busy))
    expect(passOf(state).tier).toBeGreaterThanOrEqual(8)
    const banner = steps.flatMap((one) => one.events).find((e) => e.type === "season.tier" && e.data.to >= 8)
    expect(banner?.type === "season.tier" && banner.data.rewards.exclusives).toEqual(["trailhead"])
    expect(state.holdings.inventory.some((entry) => entry.itemId === "trailhead")).toBe(false)
  })

  it("pays the beyond gold past the last tier, and plays the last tier's banner as an epic", () => {
    const near = { ...fresh(), holdings: { ...fresh().holdings, seasons: [{ id: "s1", xp: 17_900, tier: 29 }] } }
    const { state, steps } = live(busy("2026-12-10"), starterRules, [], near)
    const banners = steps.flatMap((one) => one.events.filter((e) => e.type === "season.tier"))
    expect(banners.map((e) => e.type === "season.tier" && [e.data.from, e.data.to, e.data.tier])).toEqual([
      [29, 30, "epic"],
    ])
    const past = { ...state, holdings: { ...state.holdings, seasons: [{ id: "s1", xp: 18_950, tier: 30 }] } }
    const more = live(busy("2026-12-11"), starterRules, [], past).steps.flatMap((one) => one.events)
    expect(more.find((e) => e.type === "season.tier")).toMatchObject({
      data: { from: 30, to: 31, tier: "rare", rewards: { gold: 100 } },
    })
    const gold = more.find((e) => e.type === "gold.changed" && e.data.reason === "season")
    expect(gold).toMatchObject({ data: { delta: 100 } })
  })
})

describe("the snapshot's season", () => {
  it("is upcoming before the start, running through the last day, settling for 7 days, then over", () => {
    const view = (state: PlayerState, now: string) => snapshotOf(state, now).season
    expect(view(fresh(), "2026-11-10T12:00:00.000Z")).toMatchObject({ status: "upcoming", xp: 0, tier: 0 })
    const played = live(busy("2026-11-26")).state
    expect(view(played, at("2026-11-26", 5))).toMatchObject({
      status: "running",
      xp: 600,
      tier: 3,
      intoTier: 0,
      forTier: 200,
      today: { pass: 300, cap: 300, factor: 2, doubled: true },
    })
    // The next day follows a day played: not doubled.
    expect(view(played, at("2026-11-27"))?.today).toEqual({ pass: 0, cap: 300, factor: 2, doubled: false })
    expect(view(played, at("2027-01-31"))?.status).toBe("settling")
    expect(view(played, at("2027-02-01"))).toMatchObject({ status: "over", xp: 600, tier: 3 })
    expect(view(played, at("2027-02-01"))?.today).toEqual({ pass: 0, cap: 300, factor: 2, doubled: false })
    const snapshot = snapshotOf(played, at("2026-11-26", 5))
    expect(Schema.decodeUnknownSync(SnapshotSchema)(snapshot)).toEqual(snapshot)
    const shown = new Set(snapshot.items.map((item) => item.id))
    for (const id of season1.pass.tiers.flatMap((tier) => tier.items ?? [])) expect(shown.has(id), id).toBe(true)
    expect(snapshot.season?.tiers.at(-1)).toMatchObject({ xp: 680, at: 18_000, exclusive: { id: "summit-at-dawn" } })
  })

  it("starts and ends at the player's own local midnights", () => {
    const zones = [
      ["Pacific/Kiritimati", "2026-11-25T10:00:00.000Z", "2027-01-24T10:00:00.000Z"],
      ["Asia/Jerusalem", "2026-11-25T22:00:00.000Z", "2027-01-24T22:00:00.000Z"],
      ["Pacific/Pago_Pago", "2026-11-26T11:00:00.000Z", "2027-01-25T11:00:00.000Z"],
    ] as const
    for (const [timezone, startsAt, endsAt] of zones) {
      const shown = snapshotOf(fresh(timezone), "2026-11-10T12:00:00.000Z").season
      expect(shown, timezone).toMatchObject({ startsAt, endsAt })
    }
  })

  it("counts the tiers past the last apart, and runs the bar over each 1,000 past it", () => {
    const past = { ...fresh(), holdings: { ...fresh().holdings, seasons: [{ id: "s1", xp: 20_350, tier: 32 }] } }
    expect(snapshotOf(past, at("2026-12-20")).season).toMatchObject({
      tier: 30,
      beyond: { xp: 1000, gold: 100, reached: 2 },
      intoTier: 350,
      forTier: 1000,
    })
  })

  it("shows a season that has started over the one before it, while that one still settles", () => {
    const next = { ...season1, id: "s2", name: "Season 2", startsOn: "2027-01-27", endsOn: "2027-03-28" }
    const rules = { ...starterRules, seasons: [season1, next] }
    expect([seasonShown(rules, "2027-01-26")?.id, seasonShown(rules, "2027-01-27")?.id]).toEqual(["s1", "s2"])
    expect([seasonShown(rules, "2026-11-01")?.id, seasonShown(rules, "2027-06-01")?.id]).toEqual(["s1", "s2"])
  })

  it("is absent under rules without a season", () => {
    const context = { rules: rules16, catalog: starterCatalog, questPacks: [], now: at("2026-11-26") }
    const snapshot = project(fresh(), context, meta)
    expect(Object.hasOwn(snapshot, "season")).toBe(false)
  })
})

/** A mission of `count` of a fact: a daily pays 45 XP, a weekly 150, as the starter pack's do about. */
const factMission = (
  id: string,
  cadence: "daily" | "weekly",
  fact: "commit.made" | "repo.explored" | "change.merged",
  count: number,
): QuestDef => ({
  id,
  title: id,
  cadence,
  goal: { kind: "fact", fact, count },
  rewards: { xp: cadence === "daily" ? 45 : 150 },
})

/** Missions for the pacing players: a daily for each kind of work, and a weekly for a week of each. */
const pace: QuestPack = {
  id: "pace",
  version: 1,
  title: "Pace",
  quests: [
    factMission("a-commit", "daily", "commit.made", 1),
    factMission("explore", "daily", "repo.explored", 3),
    factMission("a-merge", "daily", "change.merged", 1),
    factMission("commits-week", "weekly", "commit.made", 6),
    factMission("explore-week", "weekly", "repo.explored", 6),
    factMission("merges-week", "weekly", "change.merged", 3),
  ],
}

describe("the replay", () => {
  it("lands a seeded log across the start, the season, the end and the settle on the live run's state", () => {
    // Five weeks from 20 November to 3 February, in a pattern of days on and off, with late events and weeklies.
    let state = fresh()
    const rows: Array<Row> = []
    const steps: Array<Step> = []
    const send = (one: Row) => {
      const result = step(state, one.input, contextOf(rows.length + 1, one.now, starterRules, [pace]))
      rows.push(one)
      steps.push(result)
      state = result.state
    }
    for (let i = 0; i < 76; i++) {
      const day = addDays("2026-11-20", i)
      if (i % 7 === 3 || i % 5 === 4) continue
      send(row(event("commit.made", at(day))))
      for (const mission of state.progress.quests) {
        if (mission.status !== "offered" || mission.questId === "merges-week") continue
        send({ input: accept(mission.questId), now: at(day, 1) })
      }
      for (let p = 0; p < 12 + (i % 9); p++) send(row(prompt(at(day, 2 + p), 4 + (p % 6))))
      send(row(event("repo.explored", at(day, 30))))
      if (i % 3 === 0) send(row(event("change.merged", at(day, 31), 10)))
      // A commit made two days ago arrives now, as from an offline queue.
      if (i % 4 === 0) send(row(event("commit.made", at(addDays(day, -2), 40)), 2))
    }
    expect(passOf(state).tier).toBeGreaterThan(5)
    const again = replayed(rows, steps, [pace])
    expect(again.state).toEqual(state)
    expect(again.events).toEqual(steps.flatMap((one) => one.events))
    expect(Schema.decodeUnknownSync(PlayerStateSchema)(state)).toEqual(state)
  })
})

/** A pacing player: the days they play, and what they do on one. */
interface Player {
  readonly plays: (day: string, i: number) => boolean
  readonly prompts: number
  readonly commits: number
  readonly explores: number
  readonly merges: number
  readonly weeklies: ReadonlyArray<string>
}

/** Plays `player` through the season, a step at a time: their pass at the end, and the days it reached tiers 8 and 30. */
const playSeason = (player: Player) => {
  let state = fresh()
  let logSeq = 0
  const reachedOn: Record<number, number> = {}
  const send = (input: Input, now: string) => {
    state = step(state, input, contextOf(++logSeq, now, starterRules, [pace])).state
  }
  for (let i = 0; i < 60; i++) {
    const day = addDays(season1.startsOn, i)
    if (!player.plays(day, i)) continue
    let minute = 0
    const next = () => at(day, minute++)
    for (let c = 0; c < player.commits; c++) send(event("commit.made", next()), at(day, minute))
    for (const mission of state.progress.quests) {
      if (mission.status === "offered" && player.weeklies.includes(mission.questId)) {
        send(accept(mission.questId), next())
      }
    }
    for (let p = 0; p < player.prompts; p++) send(prompt(next()), at(day, minute))
    send(event("tests.failed", next()), at(day, minute))
    send(event("tests.passed", next()), at(day, minute))
    for (let e = 0; e < player.explores; e++) send(event("repo.explored", next()), at(day, minute))
    for (let m = 0; m < player.merges; m++) send(event("change.merged", next(), 10), at(day, minute))
    const { tier } = passOf(state)
    for (const goal of [8, 30]) if (tier >= goal && reachedOn[goal] === undefined) reachedOn[goal] = i + 1
  }
  return { ...passOf(state), tier8: reachedOn[8], tier30: reachedOn[30] }
}

const weekday = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay()

describe("pacing", () => {
  it("takes a casual player, 3 days a week and never two in a row, to tier 25-27", () => {
    // Thursday 26 and Saturday 28 November, then Monday, Wednesday and Friday: 26 days.
    const casual = playSeason({
      plays: (day, i) => (i < 4 ? i === 0 || i === 2 : [1, 3, 5].includes(weekday(day))),
      prompts: 15,
      commits: 4,
      explores: 0,
      merges: 0,
      weeklies: ["commits-week"],
    })
    expect(casual.tier).toBeGreaterThanOrEqual(25)
    expect(casual.tier).toBeLessThanOrEqual(27)
    // As the plan has it: tier 8 on Monday 7 December, day 12, and about 15,800 at the end.
    expect(casual).toEqual({ id: "s1", xp: 15_832, tier: 26, tier8: 12, tier30: undefined })
  })

  it("finishes a regular player, Monday to Friday, by day 56", () => {
    const regular = playSeason({
      plays: (day) => ![0, 6].includes(weekday(day)),
      prompts: 30,
      commits: 8,
      explores: 3,
      merges: 0,
      weeklies: ["commits-week", "explore-week"],
    })
    expect(regular.tier30).toBeLessThanOrEqual(56)
    // Tier 8 on Thursday 3 December, day 8, the last tier on Monday 18 January, day 54, and one gold tier past it.
    expect(regular).toEqual({ id: "s1", xp: 19_980, tier: 31, tier8: 8, tier30: 54 })
  })

  it("finishes a heavy player, every day with merges, no earlier than day 38", () => {
    const heavy = playSeason({
      plays: () => true,
      prompts: 50,
      commits: 20,
      explores: 3,
      merges: 2,
      weeklies: ["commits-week", "explore-week", "merges-week"],
    })
    expect(heavy.tier30).toBeGreaterThanOrEqual(38)
    // Tier 8 on Tuesday 1 December, day 6, the last tier on Monday 4 January, day 40, and 8 gold tiers past it.
    expect(heavy).toEqual({ id: "s1", xp: 26_940, tier: 38, tier8: 6, tier30: 40 })
  })
})
