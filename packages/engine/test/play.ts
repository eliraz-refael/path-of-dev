import type { ClientEvent, Context, GradeDimension, Input, PlayerState, Recorded, RulesConfig, Step } from "@pathofdev/schema"
import { Schema } from "effect"
import { initialState, starterCatalog, starterRules, step } from "../src/index.ts"

// What the engine's tests share: a fresh player, client events of each kind, the context a write gives `step`, a run
// of inputs through `step` as the write path would, its replay from the recorded rolls, and a generated script of
// events for properties.
//
//   Script (generated) ─▶ toInputs ─▶ Input[] ─▶ play ─▶ {state, steps, events}
//                                          └──────▶ replay(recorded from play) ─▶ {state, events}

export const start = "2026-10-09T08:00:00Z"
export const session = "01K6ZQ8W3J5V7XKQ2M4N6P8R9T"
export const repo: { type: "github"; repo: string; key: string } = { type: "github", repo: "acme/widgets", key: "ab".repeat(32) }

export const fresh = (): PlayerState => initialState({ characterName: "Player", timezone: "UTC", now: start })

export const minutesLater = (minutes: number): string => new Date(Date.parse(start) + minutes * 60_000).toISOString()

let ids = 0
/** ULIDs in order: the time part fixed, the counter in the random part. */
export const nextId = (): string => `01K6ZQ8W3J${String(ids++).padStart(16, "0")}`

/** The same score on every dimension. */
export const flat = (score: number): Record<GradeDimension, number> => ({
  clarity: score,
  grammar: score,
  specificity: score,
  instructive: score,
  context: score,
  doneCriteria: score,
  focus: score,
  regret: score,
})

/** An event of `type`; `n`, 0-10, varies its data: a prompt's scores, a context fill of n * 10%, and so on. */
export const client = (type: ClientEvent["type"], minutes = 0, sessionId = session, n = 10): Input => {
  const base = { id: nextId(), occurredAt: minutesLater(minutes), sessionId }
  const event = ((): ClientEvent => {
    switch (type) {
      case "turn.completed":
        return { ...base, type, data: { durationMs: 1000, toolCalls: 2 } }
      case "commit.made":
        return { ...base, type, data: { commit: { ...repo, sha: "a".repeat(40) } } }
      case "change.opened":
      case "change.merged":
        return { ...base, type, data: { change: { ...repo, number: 7 } } }
      case "review.submitted":
        return { ...base, type, data: { change: { ...repo, number: 7 }, state: "approved" } }
      case "issue.closed":
        return { ...base, type, data: { issue: { ...repo, number: 9 } } }
      case "tests.failed":
      case "tests.passed":
        return { ...base, type, data: { checkout: { ...repo, branch: "main", headSha: null }, runner: "vitest" } }
      case "repo.explored":
        return { ...base, type, data: { repo } }
      case "prompt.graded":
        return { ...base, type, data: { scores: flat(n), rubricVersion: 1, words: 12, grader: "haiku" } }
      case "session.cleared":
        return { ...base, type, data: {} }
      case "session.compacted":
        return { ...base, type, data: { trigger: n % 2 === 0 ? "manual" : "auto" } }
      case "command.used":
        return { ...base, type, data: { command: n % 2 === 0 ? "/code-review" : "/plugin:deploy" } }
      case "context.measured":
        return { ...base, type, data: { pct: n * 10 } }
    }
  })()
  return { kind: "client", event }
}

export const context = (logSeq: number, now: string, rules: RulesConfig = starterRules, mode?: Context["mode"]): Context => ({
  now,
  logSeq,
  rollSeed: "secret-seed",
  rules,
  catalog: starterCatalog,
  questPacks: [],
  mode: mode ?? { kind: "live" },
})

export const nowOf = (input: Input): string => (input.kind === "client" ? input.event.occurredAt : start)

/** Runs inputs through `step` as the write path would, numbering log rows from 1. */
export const play = (inputs: ReadonlyArray<Input>, rules?: RulesConfig, state = fresh()) => {
  const steps: Array<Step> = []
  for (const [i, input] of inputs.entries()) {
    const result = step(state, input, context(i + 1, nowOf(input), rules))
    steps.push(result)
    state = result.state
  }
  return { state, steps, events: steps.flatMap((s) => s.events) }
}

export const replay = (inputs: ReadonlyArray<Input>, recorded: ReadonlyArray<Recorded>, rules?: RulesConfig) => {
  let state = fresh()
  const events = []
  for (const [i, input] of inputs.entries()) {
    const rec = recorded[i] ?? { rolls: [], refusal: null }
    const result = step(state, input, context(i + 1, nowOf(input), rules, { kind: "replay", recorded: rec }))
    events.push(...result.events)
    state = result.state
  }
  return { state, events }
}

// A generated session: each entry is an event kind, minutes after the previous one, which of two sessions, and `n`
// for the event's data (a prompt's scores, a context fill).
export const Kind = Schema.Literals([
  "turn.completed",
  "commit.made",
  "change.opened",
  "change.merged",
  "tests.failed",
  "tests.passed",
  "repo.explored",
  "prompt.graded",
  "session.cleared",
  "session.compacted",
  "command.used",
  "context.measured",
])
export const Script = Schema.Array(
  Schema.Struct({
    kind: Kind,
    gap: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1440 })),
    second: Schema.Boolean,
    n: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 })),
  }),
).check(Schema.isMaxLength(60))

export const toInputs = (script: typeof Script.Type): Array<Input> => {
  let minutes = 0
  return script.map(({ kind, gap, second, n }) => {
    minutes += gap
    return client(kind, minutes, second ? "01K6ZQ8W3J5V7XKQ2M4N6P8R9V" : session, n)
  })
}
