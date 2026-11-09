import { it as prop } from '@effect/vitest'
import { AdminStats } from '@pathofdev/schema'
import { Schema } from 'effect'
import { describe, expect } from 'vitest'
import { adminAskOf, adminTextOf, adminUsage, isStats, onlyAdmins, statsText } from '../hooks/admin'

// The admins' stats from the prompt, as properties: the mod reads any args without throwing, reads every answer the
// server's own schema allows as the counts, and reads any answer at all into a printable line that never carries
// anything of the body's but its counts.

const Words = Schema.Array(Schema.Union([Schema.String, Schema.Literals(['admin', 'stats', 'beta', 'list'])]))

const Response = Schema.Struct({
  status: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
  text: Schema.Union([
    Schema.String,
    Schema.Literals([
      '{"players":{"total":1,"lastDay":1,"lastWeek":1},"played":{"ever":1,"lastDay":0,"lastWeek":1},' +
        '"publicProfiles":0,"historyImported":0,"promptsGraded":{"lastDay":0},"login":"mona\\u001b[31m"}',
      '{"players":{"total":-1,"lastDay":1,"lastWeek":1}}',
      '{"_tag":"Forbidden","message":"no"}',
    ]),
  ]),
})

const origin = 'https://api.pathof.dev'

describe('/pathofdev admin', () => {
  prop.prop('reads any args without throwing: the stats, the usage, or not the admins at all', [Words], ([words]) => {
    const args = words.join(' ')
    const ask = adminAskOf(args)
    const [head, ...rest] = args.trim().split(/\s+/)
    if (head !== 'admin') expect(ask).toBeNull()
    else if (rest.length === 1 && rest[0] === 'stats') expect(ask).toEqual({ kind: 'stats' })
    else expect(ask).toBe(adminUsage)
  })

  prop.prop('reads every answer the server may give as the counts, each one in the reply', [AdminStats], ([stats]) => {
    expect(isStats(stats)).toBe(true)
    const text = adminTextOf({ kind: 'stats' }, { ok: true, status: 200, text: JSON.stringify(stats) }, origin)
    expect(text).toBe(statsText(stats, origin))
    const numbers = (text.split('\n').slice(1).join(' ').match(/\d+/g) ?? []).map(Number)
    expect(numbers).toEqual([
      stats.players.total,
      stats.players.lastDay,
      stats.players.lastWeek,
      stats.played.ever,
      stats.played.lastDay,
      stats.played.lastWeek,
      stats.publicProfiles,
      stats.historyImported,
      stats.promptsGraded.lastDay,
    ])
  })

  prop.prop('reads any answer into printable text, and a 403 as for admins only', [Schema.NullOr(Response)], ([response]) => {
    const answer = response === null ? null : { ...response, ok: response.status < 300 }
    const text = adminTextOf({ kind: 'stats' }, answer, origin)
    expect(text.length).toBeGreaterThan(0)
    expect(text).toMatch(/^[\n -~·]*$/)
    expect(text).not.toContain('mona')
    if (response?.status === 403) expect(text).toBe(onlyAdmins)
  })
})
