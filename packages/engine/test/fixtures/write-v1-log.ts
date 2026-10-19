import { writeFileSync } from "node:fs"
import type {
  CheckoutRef,
  ClientEvent,
  Command,
  GradeDimension,
  Input,
  PlayerState,
  RepoRef,
  SystemEvent,
} from "@pathofdev/schema"
import { engineVersion, localDay, starterQuestPack, starterRules, step } from "../../src/index.ts"
import { goldenContext, goldenEntries, goldenId, goldenPlayer, goldenStart } from "../golden.ts"

// Writes fixtures/v1-log.json: about 300 seeded inputs over ten local days, through main's engine 14, with each
// step's events and rolls and the end state. Run once, before grading v2 changed the engine, with
//   node --conditions=@pathofdev/source packages/engine/test/fixtures/write-v1-log.ts
// It refuses to run under any other engine: the file is the record of what engine 14 did, never to be rewritten.
//
// The log covers what prices a v1 prompt: arbitrary scores in all three of a day's bands (one day grades over 40),
// turns, two or three sessions open together with prompts close enough to make parallel moments, the daily and
// weekly missions, a sigil worn and swapped, and XP food eaten.

if (engineVersion !== 14) throw new Error(`the golden v1 log is engine 14's; this is engine ${engineVersion}`)

/** mulberry32: the same numbers from the same seed, on every machine. */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
}
const next = random(20261009)
const between = (least: number, most: number): number => least + Math.floor(next() * (most - least + 1))
const clamp = (n: number): number => Math.max(0, Math.min(10, n))

const sessions = [goldenId(800_001), goldenId(800_002), goldenId(800_003)]
const repo: RepoRef = { type: "github", repo: "acme/widgets", key: "ab".repeat(32) }
const checkout: CheckoutRef = { ...repo, branch: "main", headSha: null }

interface Row {
  readonly input: Input
  readonly now: string
}
interface Written extends Row {
  readonly events: unknown
  readonly rolls: unknown
  readonly refusal: unknown
}

let ids = 0
let state: PlayerState = goldenPlayer()
const rows: Array<Written> = []

const run = (input: Input, now: string): void => {
  const result = step(state, input, goldenContext(rows.length + 1, now))
  rows.push({ input, now, events: result.events, rolls: result.rolls, refusal: result.refusal })
  state = result.state
}

const at = (ms: number): string => new Date(ms).toISOString()

/** v1 scores around a quality of its own, each 0-10, with a regret mostly low. */
const scores = (): Record<GradeDimension, number> => {
  const quality = between(1, 10)
  const one = () => clamp(quality + between(-3, 2))
  return {
    clarity: one(),
    grammar: one(),
    specificity: one(),
    instructive: one(),
    context: one(),
    doneCriteria: one(),
    focus: one(),
    regret: next() < 0.2 ? between(3, 10) : between(0, 2),
  }
}

/** One client event of a kind drawn at random: a graded prompt `promptShare` of the time. */
const clientEvent = (sessionId: string, occurredAt: string, promptShare: number): ClientEvent => {
  const base = { id: goldenId(ids++), occurredAt, sessionId }
  const pick = next()
  if (pick < promptShare) {
    const data: Extract<ClientEvent, { type: "prompt.graded" }>["data"] = {
      scores: scores(),
      rubricVersion: 1,
      words: between(6, 140),
      grader: next() < 0.9 ? "haiku" : "jev",
    }
    return { ...base, type: "prompt.graded", data }
  }
  // The rest in the shares of a working day.
  const rest = (pick - promptShare) / (1 - promptShare)
  if (rest < 0.36) {
    return { ...base, type: "turn.completed", data: { durationMs: between(500, 90_000), toolCalls: between(0, 12) } }
  }
  if (rest < 0.48) {
    return { ...base, type: "commit.made", data: { commit: { ...repo, sha: ids.toString(16).padStart(40, "0") } } }
  }
  if (rest < 0.56) return { ...base, type: "tests.failed", data: { checkout, runner: "vitest" } }
  if (rest < 0.64) return { ...base, type: "tests.passed", data: { checkout, runner: "vitest" } }
  if (rest < 0.78) return { ...base, type: "context.measured", data: { pct: between(5, 100) } }
  if (rest < 0.84) return { ...base, type: "command.used", data: { command: next() < 0.5 ? "/code-review" : "custom" } }
  if (rest < 0.9) return { ...base, type: "session.cleared", data: {} }
  if (rest < 0.94) return { ...base, type: "session.compacted", data: { trigger: next() < 0.5 ? "manual" : "auto" } }
  if (rest < 0.98) return { ...base, type: "repo.explored", data: { repo } }
  return { ...base, type: "change.opened", data: { change: { ...repo, number: between(1, 99) } } }
}

const command = (made: Command): Input => ({ kind: "command", command: made })
const system = (event: SystemEvent): Input => ({ kind: "system", event })

const dayMs = 24 * 60 * 60_000
const prompted = ["two-minds", "juggler", "conductor", "wordsmith-week"]
for (let day = 0; day < 10; day++) {
  let clock = Date.parse(goldenStart) + day * dayMs
  const open = sessions.slice(0, day % 2 === 0 ? 3 : 2)
  for (const sessionId of open) run(system({ type: "session.opened", sessionId }), at(clock))
  // The weeklies on offer, the prompt ones first, picked as the log meets them while the quest log has room.
  const offered = state.progress.quests.filter((mission) => mission.cadence === "weekly" && mission.status === "offered")
  const first = (questId: string) => (prompted.includes(questId) ? 0 : 1)
  for (const mission of offered.sort((a, b) => first(a.questId) - first(b.questId))) {
    const taken = state.progress.quests.filter((one) => one.cadence === "weekly" && one.status !== "offered").length
    if (taken >= starterRules.missions.weekly.active) break
    run(command({ id: goldenId(ids++), type: "quest.accept", data: { questId: mission.questId } }), at(clock))
  }
  // Day 3 grades over 40 prompts, into the day's last band.
  const count = day === 3 ? 62 : 22
  for (let i = 0; i < count; i++) {
    clock += between(1, day === 3 ? 6 : 14) * 60_000
    const sessionId = open[between(0, open.length - 1)] ?? goldenId(800_001)
    // Now and then an event queued offline arrives hours late.
    const late = next() < 0.05 ? between(60, 300) * 60_000 : 0
    const event = clientEvent(sessionId, at(clock - late), day === 3 ? 0.8 : 0.5)
    run({ kind: "client", event }, at(clock + 2000))
  }
  if (state.holdings.pet === null) {
    run(command({ id: goldenId(ids++), type: "pet.hatch", data: { species: "owl", name: "Hoot" } }), at(clock))
  }
  const now = at(clock)
  if (day === 2) run(command({ id: goldenId(ids++), type: "pet.feed", data: { entryId: goldenEntries.mix } }), now)
  if (day === 4) {
    const entryId = goldenEntries.storm
    run(command({ id: goldenId(ids++), type: "item.equip", data: { entryId, slot: "sigil" } }), now)
  }
  if (day === 6) run(command({ id: goldenId(ids++), type: "pet.feed", data: { entryId: goldenEntries.tart } }), now)
  if (day === 8) run(command({ id: goldenId(ids++), type: "item.unequip", data: { slot: "sigil" } }), now)
  clock += 60_000
  for (const sessionId of open) {
    run(system({ type: "session.closed", sessionId, reason: "ended", at: at(clock) }), at(clock))
  }
}

const prompts = rows.filter((row) => row.input.kind === "client" && row.input.event.type === "prompt.graded").length
const days = new Set(rows.map((row) => localDay(row.now, state.timezone))).size
const fixture = {
  about: "Engine 14's run of a seeded v1 log; written by write-v1-log.ts, never rewritten.",
  engineVersion,
  rulesVersion: starterRules.version,
  questPack: starterQuestPack,
  steps: rows,
  end: state,
}
writeFileSync(new URL("./v1-log.json", import.meta.url), `${JSON.stringify(fixture, null, 1)}\n`)
console.log(`${rows.length} inputs, ${prompts} prompts, ${days} local days`)
