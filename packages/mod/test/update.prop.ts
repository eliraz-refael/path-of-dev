import { it as prop } from '@effect/vitest'
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { compareVersions, updateOf } from '../hooks/update'

// The mod's versions as properties: semver's precedence is an order (it reverses with its sides, ranks a version with
// itself and holds through a third), it follows the numbers, a pre-release comes before its release, and build
// metadata counts for nothing; an update is told only for a version newer than the mod's.

const part = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 12 }))
// Words and numbers, the numbers past one digit too, so `2` before `11` reads as numbers do and not as text.
const Identifier = Schema.Literals(['alpha', 'beta', 'rc', 'x-1', 'A', '0', '1', '2', '11'])
const Version = Schema.Struct({
  core: Schema.Tuple([part, part, part]),
  pre: Schema.Array(Identifier).check(Schema.isMaxLength(3)),
})
type Drawn = typeof Version.Type

const textOf = (drawn: Drawn): string => `${drawn.core.join('.')}${drawn.pre.length === 0 ? '' : `-${drawn.pre.join('.')}`}`
const releaseOf = (drawn: Drawn): string => drawn.core.join('.')

describe('comparing versions', () => {
  prop.prop('is an order: it reverses with its sides, and ranks a version with itself', [Version, Version], ([a, b]) => {
    const by = compareVersions(textOf(a), textOf(b))
    expect(by).not.toBeNull()
    expect(compareVersions(textOf(b), textOf(a))).toBe(-(by ?? 0) || 0)
    expect(compareVersions(textOf(a), textOf(a))).toBe(0)
  })

  prop.prop('holds through a third', [Version, Version, Version], ([a, b, c]) => {
    const sorted = [a, b, c].map(textOf).sort((x, y) => compareVersions(x, y) ?? 0)
    for (let i = 0; i < 2; i++) expect(compareVersions(sorted[i] ?? '', sorted[i + 1] ?? '')).toBeLessThanOrEqual(0)
    expect(compareVersions(sorted[0] ?? '', sorted[2] ?? '')).toBeLessThanOrEqual(0)
  })

  prop.prop('follows the numbers, a pre-release coming before its release', [Version, Version], ([a, b]) => {
    const [x, y, z] = a.core
    const [p, q, r] = b.core
    const byNumbers = Math.sign(x - p || y - q || z - r)
    if (byNumbers !== 0) expect(compareVersions(textOf(a), textOf(b))).toBe(byNumbers)
    if (a.pre.length > 0) expect(compareVersions(textOf(a), releaseOf(a))).toBe(-1)
  })

  prop.prop('counts build metadata for nothing', [Version, Schema.Literals(['build.1', '20261021', 'sha.5ab8ed9'])], ([a, build]) => {
    expect(compareVersions(`${textOf(a)}+${build}`, textOf(a))).toBe(0)
  })

  prop.prop('tells an update only for a newer version', [Version, Version], ([mod, latest]) => {
    const found = updateOf(textOf(mod), textOf(latest), '0.0.0')
    if ((compareVersions(textOf(latest), textOf(mod)) ?? 0) > 0)
      expect(found).toEqual({ from: textOf(mod), to: textOf(latest), needs: null })
    else expect(found).toBeNull()
  })

  it('reads none of what is not a semantic version', () => {
    for (const text of ['', '1', '1.2', '1.2.3.4', 'v1.2.3', '01.2.3', '1.2.3-', '1.2.3-a..b', ' 1.2.3'])
      expect({ text, by: compareVersions(text, '1.2.3') }).toEqual({ text, by: null })
  })
})
