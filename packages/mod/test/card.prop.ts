import { it as prop } from '@effect/vitest'
import type { GradedV2 } from '@pathofdev/schema'
import { GradedV2 as GradedV2Schema } from '@pathofdev/schema'
import { describe, expect, it } from 'vitest'
// The engine's own pricing, read from its source: the mod can't import the engine where it runs, so the card works the
// formula out again, and these hold the two together.
import { gradeV2 } from '../../engine/src/stats.ts'
import { starterRules } from '../../engine/src/starter.ts'
import { breakdownOf, pricingOf } from '../hooks/card'
import type { Pricing } from '../types'

// The Last prompt card's breakdown of a rubric 2 grade, against the engine's `gradeV2`: from the same measures and the
// same rules it comes to the same grade, the plan's seven controls and any prompt at all, and its parts add up to it.

const v2 = starterRules.prompt.v2
const pricing: Pricing | null = pricingOf(v2)

const control = (
  kind: GradedV2['kind'],
  [intent, grounding, why, successShape, scope, forward, craft, tone]: [
    number,
    number,
    number | null,
    number | null,
    number,
    number,
    number,
    number,
  ],
  words: number,
): GradedV2 => ({
  rubricVersion: 2,
  kind,
  measures: { intent, grounding, why, successShape, scope, forward, craft, tone },
  spelledClean: true,
  words,
  grader: 'haiku',
})

// The plan's seven synthetic controls (docs/plans/grading-v2.md), and the grades it says they come to.
const controls: ReadonlyArray<readonly [string, GradedV2, number]> = [
  ['a: fix it, after a failing test', control('steer', [8, 8, null, null, 9, 7, 6, 6], 2), 7.9],
  ['b: fix it, no context', control('task', [2, 1, null, 1, 5, 2, 3, 5], 2), 2.2],
  ['c: yes, start step 1, after a plan', control('task', [8, 9, null, 7, 9, 8, 7, 6], 4), 8.3],
  ['d: a crisp bug report', control('task', [9, 9, 8, 8, 9, 8, 8, 6], 84), 9.2],
  ['e: rambling, contradictory', control('task', [5, 5, 3, 3, 2, 3, 5, 6], 61), 4],
  ['f: rude, cursing', control('steer', [6, 7, 3, null, 8, 4, 4, 1], 10), 3.5],
  ['g: a polished, kind discussion', control('discussion', [9, 9, 8, 8, 9, 8, 8, 8], 78), 9.3],
]

/** The parts' sum as the grade: clamped, held by what held it, to one decimal. */
const summed = (parts: ReturnType<typeof breakdownOf>): number => {
  const sum = parts.base + parts.craft + parts.spelling + parts.tone
  const held = parts.held === null ? sum : parts.held.at
  return Math.round(Math.round(Math.min(10, Math.max(0, held)) * 1000) / 100) / 10
}

describe("the card's breakdown of a rubric 2 grade", () => {
  it('reads the starter rules whole', () => {
    expect(pricing).not.toBeNull()
  })

  it("comes to the engine's grade on the plan's seven controls, and the parts add up to it", () => {
    if (pricing === null) throw new Error('no pricing')
    for (const [name, one, grade] of controls) {
      const parts = breakdownOf(pricing, one)
      expect({ name, grade: parts.grade }).toEqual({ name, grade })
      expect({ name, grade: gradeV2(v2, one) }).toEqual({ name, grade })
      expect({ name, summed: summed(parts) }).toEqual({ name, summed: grade })
    }
  })

  it('names the cap that held a steer and a hostile prompt', () => {
    if (pricing === null) throw new Error('no pricing')
    const steer = controls.find(([name]) => name.startsWith('a'))?.[1]
    const rude = controls.find(([name]) => name.startsWith('f'))?.[1]
    if (steer === undefined || rude === undefined) throw new Error('no control')
    const proud = { ...steer, measures: { ...steer.measures, intent: 10, grounding: 10, scope: 10, forward: 10 } }
    expect(breakdownOf(pricing, proud).held).toEqual({ by: 'steer', at: 8 })
    expect(breakdownOf(pricing, rude).held).toEqual({ by: 'hostile', at: 3.5 })
    expect(breakdownOf(pricing, controls[3]?.[1] ?? steer).held).toBeNull()
  })

  prop.prop("comes to the engine's grade for any prompt, and its parts add up to it", [GradedV2Schema], ([one]) => {
    if (pricing === null) throw new Error('no pricing')
    const parts = breakdownOf(pricing, one)
    expect(parts.grade).toBe(gradeV2(v2, one))
    expect(summed(parts)).toBe(parts.grade)
  })
})
