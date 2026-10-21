import { it as prop } from '@effect/vitest'
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { factsOf, isFresh, keptAfter, keptForMs, openedOf, prViewOf, pullOf, withOpened } from '../hooks/merges'

// The changes the mod keeps to see them merge, as properties: what a check leaves kept, what a view of `gh` reads as,
// and what a merge says of itself, which is numbers and a yes or no, never a name.

const between = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }))

const Opened = Schema.Struct({
  repo: Schema.Literals(['acme/widgets', 'ada/tools', 'Acme/Widgets']),
  number: between(1, 6),
  openedAt: between(0, 2 * keptForMs),
})
const Kept = Schema.Array(Opened).check(Schema.isMaxLength(12))
const Settled = Schema.Array(Schema.Struct({ repo: Schema.Literals(['acme/widgets', 'ada/tools']), number: between(1, 6) }))

describe('the changes kept', () => {
  prop.prop('keep none a check settled or that is past a month, and every other', [Kept, Settled], ([kept, settled]) => {
    const now = 2 * keptForMs
    const left = keptAfter(kept, settled, now)
    const same = (a: { repo: string; number: number }, b: { repo: string; number: number }) =>
      a.repo.toLowerCase() === b.repo.toLowerCase() && a.number === b.number
    for (const one of left) {
      expect(isFresh(one, now)).toBe(true)
      expect(settled.some((done) => same(done, one))).toBe(false)
    }
    const expected = kept.filter((one) => isFresh(one, now) && !settled.some((done) => same(done, one)))
    expect(left).toEqual(expected)
  })

  prop.prop('hold a change once, however often it is opened', [Kept, Opened], ([kept, opened]) => {
    const once = withOpened(withOpened(kept, opened), opened)
    expect(withOpened(once, opened)).toEqual(once)
    expect(once.filter((one) => one.repo.toLowerCase() === opened.repo.toLowerCase() && one.number === opened.number).length).toBeGreaterThanOrEqual(1)
  })

  it('read back from the store only in their own shape', () => {
    const good = { repo: 'acme/widgets', number: 7, openedAt: 1 }
    expect(openedOf([good, { repo: 'nope', number: 1, openedAt: 1 }, { ...good, number: 1.5 }, null, 'x'])).toEqual([good])
    expect(openedOf({ repo: 'acme/widgets' })).toEqual([])
  })
})

const View = Schema.Struct({
  state: Schema.Literals(['OPEN', 'MERGED', 'CLOSED']),
  author: Schema.Literals(['ada', 'Ada', 'bob', 'acme']),
  additions: between(0, 5_000),
  deletions: between(0, 5_000),
  repo: Schema.Literals(['acme/widgets', 'ada/tools', 'ADA/tools']),
})

describe('a change as gh tells it', () => {
  prop.prop('reads its state, author and size, and says its repo is its own by the owner alone', [View], ([drawn]) => {
    const view = prViewOf(JSON.stringify({ ...drawn, author: { login: drawn.author, name: 'Someone' } }))
    expect(view).toEqual({ state: drawn.state, author: drawn.author, additions: drawn.additions, deletions: drawn.deletions })
    if (view === null) return
    const facts = factsOf(drawn.repo, view)
    expect(facts).toEqual({
      additions: drawn.additions,
      deletions: drawn.deletions,
      isOwnRepo: drawn.repo.split('/')[0]?.toLowerCase() === drawn.author.toLowerCase(),
    })
    // Numbers and a yes or no: nothing that names the repo.
    expect(JSON.stringify(facts)).not.toMatch(/acme|ada|tools|widgets/i)
  })

  it('is nothing in another shape', () => {
    for (const stdout of ['', 'not json', '[]', '{"state":"DRAFT","additions":1,"deletions":1}', '{"state":"OPEN","additions":-1,"deletions":1}']) {
      expect(prViewOf(stdout)).toBeNull()
    }
  })

  it('names a change by its URL only on github.com', () => {
    expect(pullOf('https://github.com/acme/widgets/pull/7')).toEqual({ repo: 'acme/widgets', number: 7 })
    expect(pullOf('https://github.com/acme/widgets/pull/7/\n')).toEqual({ repo: 'acme/widgets', number: 7 })
    expect(pullOf('https://gitlab.com/acme/widgets/pull/7')).toBeNull()
    expect(pullOf('https://github.com/acme/widgets/issues/7')).toBeNull()
    expect(pullOf(undefined)).toBeNull()
  })
})
