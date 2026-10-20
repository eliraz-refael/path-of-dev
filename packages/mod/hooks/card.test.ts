import { describe, expect, test } from 'claude-code/testing'
import type { ServerEvent } from '@pathofdev/schema'
import type { Pricing, ScoredPrompt } from '../types'
import { cardRows, cardText, noCardText, pricedOf, pricingOf, scoredAfter, signed } from './card'
import type { CardInput } from './card'
import { cellsOfRow } from './cells'

// The Last prompt card as its builder lays it out from plain values: the head with the server's grade and XP (or
// "pending"), the measures with a dash for one that didn't apply, the breakdown by the rules' numbers with any cap
// that held the grade, and the note.

/** The starter rules' `prompt.v2` pricing, as a server from grading v2 sends it. */
const V2 = {
  maxXp: 15,
  weights: { intent: 1.5, grounding: 1, why: 1, successShape: 1, scope: 1, forward: 1.5 },
  craft: { from: 6, span: 4, max: 0.5 },
  spelling: { fullAtWords: 60, max: 0.4 },
  tone: { upFrom: 6, upPer: 0.075, downFrom: 4, downPer: 0.6 },
  caps: { hostile: { toneAtMost: 2, grade: 3.5 }, steer: { grade: 8 } },
  loot: { chanceAtTen: 0.175, greatAt: 9 },
}
const pricing: Pricing = {
  weights: V2.weights,
  craft: V2.craft,
  spelling: V2.spelling,
  tone: V2.tone,
  caps: V2.caps,
}

const scoredV2 = (more: Partial<Extract<ScoredPrompt, { rubric: 2 }>> = {}): Extract<ScoredPrompt, { rubric: 2 }> => ({
  rubric: 2,
  id: 'p1',
  kind: 'task',
  measures: { intent: 9, grounding: 8, why: null, successShape: null, scope: 9, forward: 8, craft: 8, tone: 7 },
  spelledClean: true,
  words: 30,
  pricing,
  priced: { grade: 9, xp: 13 },
  ...more,
})

const card = (scored: ScoredPrompt, more: Partial<CardInput> = {}): CardInput => ({
  scored,
  note: "Say which test should pass when it's done.",
  misspelled: [],
  ...more,
})

describe('the Last prompt card', () => {
  test("says the server's grade and XP, the measures, the parts that make the grade, and the note", () => {
    expect(cardText(card(scoredV2()))).toBe(
      [
        'Last prompt · 9.0 · +13 XP · task',
        "intent 9  grounding 8  why –  success –  scope 9  forward 8  – didn't apply",
        'base 8.5 · craft +0.3 · spelling +0.2 · tone +0.1',
        "“Say which test should pass when it's done.”",
      ].join('\n'),
    )
  })

  test('says pending, with the measures, until the server prices the prompt', () => {
    const text = cardText(card(scoredV2({ priced: null })))
    expect(text.split('\n')[0]).toBe('Last prompt · pending · task')
    expect(text).toContain('intent 9  grounding 8')
    expect(text).not.toContain('XP')
  })

  test('says nothing of a dash when every measure applied', () => {
    const measures = { intent: 9, grounding: 8, why: 7, successShape: 6, scope: 9, forward: 8, craft: 6, tone: 5 }
    expect(cardText(card(scoredV2({ measures })))).not.toContain('–')
  })

  test('names the cap that held a steer, and colors it as a warning', () => {
    const measures = { ...scoredV2().measures, intent: 10, grounding: 10, scope: 10, forward: 10, craft: 9, tone: 8 }
    const rows = cardRows(card(scoredV2({ kind: 'steer', measures, priced: { grade: 8, xp: 12 } })), null)
    const cap = rows.flat().find((run) => run.text === 'steer cap 8.0')
    expect(cap?.color).toBe('warning')
  })

  test("names the hostile cap, and the tone's cost", () => {
    const measures = { intent: 6, grounding: 7, why: 3, successShape: null, scope: 8, forward: 4, craft: 4, tone: 1 }
    const text = cardText(card(scoredV2({ kind: 'task', measures, priced: { grade: 3.5, xp: 5 } })))
    expect(text).toContain('tone -1.8')
    expect(text).toContain('hostile cap 3.5')
  })

  test('says the words to check while the mod remembers them, and only that it was not clean once it forgets', () => {
    const unclean = scoredV2({ spelledClean: false })
    expect(cardText(card(unclean, { misspelled: ['recieve', 'teh'] }))).toContain('spelling +0 (check: recieve, teh)')
    expect(cardText(card(unclean, { misspelled: null }))).toContain('spelling +0 (not clean)')
    expect(cardText(card(unclean, { misspelled: null }))).not.toContain('recieve')
  })

  test('shows the craft, the tone and the spelling as they were when the rules carried no pricing', () => {
    const text = cardText(card(scoredV2({ pricing: null })))
    expect(text).toContain('craft 8 · tone 7 · spelling clean')
    expect(text).not.toContain('base')
  })

  test("shows rubric 1's scores against a server that grades by rubric 1", () => {
    const scored: ScoredPrompt = {
      rubric: 1,
      id: 'p1',
      scores: {
        clarity: 7,
        grammar: 8,
        specificity: 5,
        instructive: 6,
        context: 4,
        doneCriteria: 3,
        focus: 9,
        regret: 1,
      },
      words: 14,
      priced: { grade: 6.1, xp: 12 },
    }
    expect(cardText(card(scored, { note: null }))).toBe(
      [
        'Last prompt · 6.1 · +12 XP',
        'clarity 7  grammar 8  specificity 5  instructive 6  context 4  done 3  focus 9',
        'regret 1, not in the grade',
      ].join('\n'),
    )
  })

  test('breaks a line between its pieces to fit a narrow card, the note between its words', () => {
    for (const columns of [24, 32, 40, 60]) {
      const rows = cardRows(card(scoredV2()), columns)
      for (const row of rows) expect(cellsOfRow(row)).toBeLessThanOrEqual(columns)
      expect(rows.length).toBeGreaterThan(4)
    }
  })

  test('signs a part to one decimal, nothing as +0', () => {
    const parts = [0.25, 0.04, -0.04, -1.8, 0].map(signed)
    expect(parts).toEqual(['+0.3', '+0', '+0', '-1.8', '+0'])
  })

  test('before any prompt was graded, says how to get one', () => {
    expect(noCardText(6)).toBe('No prompt graded yet: type one of 6 words or more, and how it was scored shows here.')
  })
})

describe("the card's numbers", () => {
  test("reads the rules' pricing whole, and none from rules that lack a number or divide by nothing", () => {
    expect(pricingOf(V2)).toEqual(pricing)
    expect(pricingOf(undefined)).toBeNull()
    expect(pricingOf({ ...V2, craft: { from: 6, max: 0.5 } })).toBeNull()
    expect(pricingOf({ ...V2, spelling: { fullAtWords: 0, max: 0.4 } })).toBeNull()
  })

  const xp = (cause: string, grade?: number): ServerEvent => ({
    seq: 1,
    at: '2026-10-09T08:00:00.000Z',
    cause,
    type: 'xp.granted',
    data: {
      amount: 12,
      tier: 'reported',
      reason: 'prompt.graded',
      totalAfter: 150,
      ...(grade === undefined ? {} : { grade }),
    },
  })

  test("takes the server's grade and XP for this prompt alone", () => {
    expect(pricedOf([xp('p1', 8.2)], 'p1')).toEqual({ grade: 8.2, xp: 12 })
    expect(pricedOf([xp('p2', 8.2)], 'p1')).toBeNull()
    expect(pricedOf([xp('p1')], 'p1')).toBeNull()
    expect(scoredAfter(scoredV2({ priced: null }), [xp('p1', 7.5)])?.priced).toEqual({ grade: 7.5, xp: 12 })
    expect(scoredAfter(null, [xp('p1', 7.5)])).toBeNull()
  })
})
