import { it as prop } from '@effect/vitest'
import type { ServerEvent } from '@pathofdev/schema'
import { Rarity } from '@pathofdev/schema'
import { Schema } from 'effect'
import { describe, expect } from 'vitest'
import { badgeBurstOf, celebrationOf, tierRank } from '../hooks/celebrate'
import { badgePart, batchGainOf, gainOf, toastOf } from '../hooks/view'
import type { Celebration } from '../types'

// A badge unlocked, as properties: it celebrates at the tier the server names, a batch's badges play as one that
// counts the rest, and the band's line and the toast name them.

const Title = Schema.Union([Schema.Literals(['First commit', 'Never past 75']), Schema.String.check(Schema.isMinLength(1))])
const Glyph = Schema.Literals(['📝', '★', '🏔️'])

const at = '2026-10-09T08:00:00.000Z'

const unlocked = (title: string, tier: string, glyph: string, seq = 1): ServerEvent =>
  ({
    seq,
    at,
    cause: null,
    type: 'achievement.unlocked',
    data: { achievementId: 'some-badge', title, tier, glyph },
  }) as ServerEvent

const levelUp: ServerEvent = { seq: 9, at, cause: null, type: 'level.up', data: { from: 1, to: 2, tier: 'rare' } } as ServerEvent

const Badge = Schema.Struct({ title: Title, tier: Rarity, glyph: Glyph, more: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })) })
const Other = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('xp'), amount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })) }),
  Schema.Struct({ kind: Schema.Literal('loot'), tier: Rarity, name: Title, gold: Schema.Literal(0), more: Schema.Literal(0) }),
])
/** A batch's celebrations in arrival order: badges among the others. */
const Batch = Schema.Array(Schema.Union([Badge, Other])).check(Schema.isMaxLength(12))

const celebrationsOf = (batch: typeof Batch.Type): Array<Celebration> =>
  batch.map((one) => ('kind' in one ? one : { kind: 'badge', ...one }))

/** How many badges a celebration stands for. */
const badgesIn = (celebrations: ReadonlyArray<Celebration>): number =>
  celebrations.reduce((sum, one) => sum + (one.kind === 'badge' ? one.more + 1 : 0), 0)

describe('a badge unlocked', () => {
  prop.prop('celebrates at its tier, with its name and glyph', [Title, Rarity, Glyph], ([title, tier, glyph]) => {
    expect(celebrationOf(unlocked(title, tier, glyph), '⚔')).toEqual({ kind: 'badge', tier, title, glyph, more: 0 })
  })

  prop.prop('plays a tier this mod does not know as common', [Schema.String, Title], ([tier, title]) => {
    const celebration = celebrationOf(unlocked(title, tier, '★'), '⚔')
    expect(celebration?.kind === 'badge' && celebration.tier).toBe(Rarity.literals.some((one) => one === tier) ? tier : 'common')
  })

  prop.prop('names the badge on the band and wins the line over all but a level-up', [Title, Rarity, Glyph], ([title, tier, glyph]) => {
    const event = unlocked(title, tier, glyph)
    expect(gainOf(event)).toEqual({ text: `${glyph} ${title} · badge unlocked`, tone: 'badge' })
    const xp = { seq: 2, at, cause: null, type: 'xp.granted', data: { amount: 3, tier: 'reported', reason: 'commit.made', totalAfter: 3 } }
    expect(batchGainOf([event, xp as ServerEvent])?.tone).toBe('badge')
    expect(batchGainOf([event, levelUp])?.tone).toBe('level')
  })
})

describe('a batch of badges', () => {
  prop.prop('plays as one, the rarest, counting the rest, and drops none', [Batch], ([batch]) => {
    const before = celebrationsOf(batch)
    const after = badgeBurstOf(before)
    const badges = before.filter((one) => one.kind === 'badge')
    expect(badgesIn(after)).toBe(badgesIn(before))
    expect(after.filter((one) => one.kind === 'badge')).toHaveLength(Math.min(1, badges.length))
    expect(after.filter((one) => one.kind !== 'badge')).toEqual(before.filter((one) => one.kind !== 'badge'))
    const [burst] = after.filter((one) => one.kind === 'badge')
    if (burst?.kind === 'badge') expect(tierRank(burst.tier)).toBe(Math.max(...badges.map((one) => tierRank(one.tier))))
  })

  prop.prop('toasts up to three badges by name and counts the rest', [Schema.Array(Title).check(Schema.isMaxLength(8))], ([titles]) => {
    const events = titles.map((title, i) => unlocked(title, 'common', '★', i + 1))
    const [part] = badgePart(events)
    if (titles.length === 0) {
      expect(part).toBeUndefined()
      return
    }
    const named = titles.length > 3 ? titles.slice(0, 2) : titles
    for (const title of named) expect(part).toContain(`★ ${title}`)
    if (titles.length > 3) expect(part?.endsWith(` and ${titles.length - 2} more`)).toBe(true)
    expect(toastOf(events)).toContain(part)
  })
})
