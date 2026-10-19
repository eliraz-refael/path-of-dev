import { it as prop } from '@effect/vitest'
import type { ServerEvent } from '@pathofdev/schema'
import { Schema } from 'effect'
import { describe, expect } from 'vitest'
import { cellsOfRow } from '../hooks/cells'
import type { Reaction, StepContext, Walker } from '../hooks/pet-motion'
import { faceOf, homeWalker, laneRow, laneWidthOf, reactionsOf, stepWalker, withReactions } from '../hooks/pet-motion'

// The living pet, as properties: its lane is exactly as wide as the band gives it with the face whole inside, the
// walker never leaves its room or steps quicker than a trot, and nothing short of a good moment makes it react.

const between = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }))

const Mark = Schema.NullOr(Schema.Struct({ text: Schema.Literals(['✧', '♪', '●', '♥', ' z z', '◆', '\\', '/']) }))
const Pose = Schema.Struct({
  away: between(0, 40),
  facing: Schema.Literals(['left', 'right']),
  look: Schema.Literals(['idle', 'happy', 'chew', 'asleep']),
  back: Mark,
  front: Mark,
  isAway: Schema.Boolean,
})
const Pet = Schema.Struct({ species: Schema.Literals(['fox', 'slime', 'robot', 'owl', 'dragon']), form: between(0, 5) })
const Tip = Schema.NullOr(Schema.Literals(['', 'name the file', 'say what done looks like']))

describe('the lane', () => {
  prop.prop(
    'is exactly as wide as laneWidthOf says, the face whole inside it, whatever the pose, room and text beside it',
    [Pose, Pet, Schema.Boolean, between(-10, 60), Tip],
    ([pose, pet, wanders, room, tip]) => {
      const face = faceOf(pet, pose.look, pose.facing)
      const beside = tip === null ? null : [{ text: tip }]
      const width = laneWidthOf(face, pose, wanders, room, beside)
      const row = laneRow(face, pose, width, beside)
      expect(cellsOfRow(row)).toBe(width)
      const drawn = row.map((run) => run.text).join('')
      expect(drawn.split(face).length - 1).toBe(pose.isAway ? 0 : 1)
      if (!pose.isAway && tip !== null && tip !== '') expect(drawn).toContain(tip)
    },
  )
})

const Step = Schema.Struct({
  wanders: Schema.Boolean,
  animates: Schema.Boolean,
  free: Schema.Boolean,
  sleepy: Schema.Boolean,
  room: between(0, 14),
  reaction: Schema.NullOr(Schema.Literals(['hop', 'eat', 'pat', 'cheer', 'fetch'])),
})

const reactionOf = (kind: 'hop' | 'eat' | 'pat' | 'cheer' | 'fetch'): Reaction =>
  kind === 'fetch' ? { kind, item: { text: '◆' } } : { kind }

describe('the walker', () => {
  prop.prop(
    'stays inside the room each step gives it, and never steps quicker than a trot, over any run of steps',
    [Schema.Array(Step).check(Schema.isMaxLength(200))],
    ([steps]) => {
      let walker: Walker = homeWalker
      for (const step of steps) {
        if (step.reaction !== null) walker = withReactions(walker, [reactionOf(step.reaction)])
        const context: StepContext = step
        const next = stepWalker(walker, context)
        walker = next.walker
        expect(walker.away).toBeGreaterThanOrEqual(0)
        expect(walker.away).toBeLessThanOrEqual(step.room)
        if (next.waitMs !== null) expect(next.waitMs).toBeGreaterThanOrEqual(250)
        // Held by a turn or a celebration, it plays nothing and plans nothing.
        if (!step.free) expect(next.waitMs).toBeNull()
        if (!step.free) expect(walker.act).toBeNull()
      }
    },
  )

  prop.prop(
    'stays inside a room that shrinks while it walks or plays a reaction, wherever it was going or began',
    [Schema.Array(Step).check(Schema.isMaxLength(40)), Step, between(0, 3)],
    ([steps, last, shrunk]) => {
      // The band wide while it sets off, then narrow: a walk or a reaction under way meets a room that no longer holds it.
      const wide = steps.reduce<Walker>((walker, step) => {
        const ready = step.reaction === null ? walker : withReactions(walker, [reactionOf(step.reaction)])
        return stepWalker(ready, { ...step, free: true, room: 14 }).walker
      }, homeWalker)
      const narrowed: StepContext = { ...last, free: true, wanders: true, room: shrunk }
      // Long enough for any reaction to play out and come back to where it began.
      Array.from({ length: 10 }).reduce<Walker>((walker) => {
        const next = stepWalker(walker, narrowed).walker
        expect(next.away).toBeLessThanOrEqual(shrunk)
        return next
      }, wide)
    },
  )
})

/** Moments that are not good ones: a prompt graded under the line or not graded, any other XP, gold, a capped day. */
const grade = (minimum: number, maximum: number) => Schema.Finite.check(Schema.isBetween({ minimum, maximum }))
const Quiet = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('prompt'), grade: Schema.NullOr(grade(0, 6.949)) }),
  Schema.Struct({
    kind: Schema.Literal('xp'),
    reason: Schema.Literals(['commit.made', 'streak.day', 'quest', 'dev']),
    grade: grade(0, 10),
  }),
  Schema.Struct({ kind: Schema.Literal('gold'), delta: between(-500, 500) }),
  Schema.Struct({ kind: Schema.Literal('capped') }),
])

const at = '2026-10-09T08:00:00.000Z'
const cause = '01K6ZQ8W3J0000000000000P01'

const quietEvent = (moment: typeof Quiet.Type, seq: number): ServerEvent => {
  switch (moment.kind) {
    case 'prompt': {
      const graded = moment.grade === null ? {} : { grade: moment.grade }
      const data = { amount: 3, reason: 'prompt.graded', totalAfter: 3, ...graded }
      return { seq, at, cause, type: 'xp.granted', data: { ...data, tier: 'reported' } }
    }
    case 'xp': {
      const { reason, grade } = moment
      return { seq, at, cause, type: 'xp.granted', data: { amount: 3, tier: 'verified', reason, totalAfter: 3, grade } }
    }
    case 'gold':
      return { seq, at, cause, type: 'gold.changed', data: { delta: moment.delta, totalAfter: 600, reason: 'drop' } }
    case 'capped':
      return { seq, at, cause, type: 'xp.capped', data: { eventType: 'prompt.graded', cap: 100 } }
  }
}

describe('what the pet reacts to', () => {
  prop.prop(
    'a batch with no well-graded prompt, drop, meal, pat or celebration earns no reaction, in any motion',
    [Schema.Array(Quiet).check(Schema.isMaxLength(8)), Schema.Literals(['full', 'reduced', 'off'])],
    ([moments, motion]) => {
      expect(reactionsOf(moments.map(quietEvent), motion)).toEqual([])
    },
  )

  prop.prop(
    'a prompt graded 7 or more always earns a hop, whatever quieter moments come with it',
    [Schema.Array(Quiet).check(Schema.isMaxLength(8)), grade(7, 10)],
    ([moments, graded]) => {
      const good: ServerEvent = {
        seq: 99,
        at,
        cause,
        type: 'xp.granted',
        data: { amount: 12, tier: 'reported', reason: 'prompt.graded', totalAfter: 12, grade: graded },
      }
      const kinds = reactionsOf([...moments.map(quietEvent), good], 'full').map((one) => one.kind)
      expect(kinds).toContain('hop')
    },
  )
})
