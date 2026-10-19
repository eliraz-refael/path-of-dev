import { it } from "@effect/vitest"
import { gradeV2, starterRules } from "@pathofdev/engine"
import type { GradedV2, PromptGraded } from "@pathofdev/schema"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { client, nextId, prompt, session, start, withServer } from "./fixtures.ts"

// Grading v2 at the edge: the server takes a prompt graded with either rubric and prices each by its own formula, and
// its rules advertise rubric 2, which is what a mod that grades with it looks for.

const graded: GradedV2 = {
  rubricVersion: 2,
  kind: "task",
  measures: { intent: 9, grounding: 8, why: null, successShape: 7, scope: 9, forward: 8, craft: 7, tone: 6 },
  spelledClean: true,
  words: 40,
  grader: "haiku",
}

const promptV2 = (data: GradedV2 = graded, id = nextId()): typeof PromptGraded.Type => ({
  id,
  type: "prompt.graded",
  occurredAt: start,
  sessionId: session,
  data,
})

describe("POST /v1/events: grading v2", () => {
  it.effect("prices a rubric 1 prompt as before and a rubric 2 one by rubric 2, and the stats start afresh", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        const grade = gradeV2(starterRules.prompt.v2, graded)
        const response = yield* api.sendEvents({ payload: { events: [prompt(8), promptV2()] } })
        expect(response.results.map((result) => result.status)).toEqual(["accepted", "accepted"])
        const grants = response.events.flatMap((event) =>
          event.type === "xp.granted" && event.data.reason === "prompt.graded" ? [event.data] : [],
        )
        // 20 * 8 / 10 for rubric 1, 15 * grade / 10 for rubric 2, each rounded down once.
        expect(grants).toEqual([
          expect.objectContaining({ amount: 16, grade: 8 }),
          expect.objectContaining({ amount: Math.floor((15 * grade) / 10), grade }),
        ])
        const opened = yield* api.openSession({ payload: { sessionId: session } })
        expect(opened.rules.prompt.rubricVersion).toBe(2)
        expect(opened.rules.prompt.v2.maxXp).toBe(15)
        expect(opened.rules.prompt.maxXp).toBe(20)
        // The rubric 1 prompt still counts toward the day, but the counts now hold rubric 2's prompt alone.
        expect(opened.snapshot.stats.prompts).toEqual({ graded: 1, gradedToday: 2, averageScore: grade, regretted: 0 })
        expect(opened.snapshot.stats.grades).toMatchObject({
          best: grade,
          measures: { intent: 9, grounding: 8, successShape: 7, scope: 9, forward: 8, craft: 7, tone: 6 },
        })
        expect(opened.snapshot.stats.grades.measures).not.toHaveProperty("why")
      }),
    ),
  )

  it.effect("rejects a prompt of an unknown rubric, or one shaped for the other rubric, as invalid", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        const v1 = prompt(8)
        const events = [
          { ...v1, data: { ...v1.data, rubricVersion: 3 } },
          { ...v1, id: nextId(), data: { ...v1.data, rubricVersion: 2 } },
          { ...promptV2(), data: { ...graded, rubricVersion: 1 } },
          { ...promptV2(), data: { ...graded, kind: "chat" } },
          { ...promptV2(), data: { ...graded, spelledClean: "yes" } },
          { ...promptV2(), data: { ...graded, measures: { ...graded.measures, intent: 7.5 } } },
        ]
        const response = yield* api.sendEvents({ payload: { events } })
        expect(response.results.map((result) => [result.status, result.reason])).toEqual(
          Array(events.length).fill(["rejected", "invalid"]),
        )
        expect(response.events).toEqual([])
      }),
    ),
  )
})
