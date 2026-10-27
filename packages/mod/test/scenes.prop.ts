import { it as prop } from '@effect/vitest'
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import type { OwnedItem, Wardrobe } from '../types'
import { cellsOfRow } from '../hooks/cells'
import { otherItems } from '../hooks/pane'
import { petInScene, petPixels, sceneArt, sceneSize } from '../hooks/scene-art'
import {
  artOf,
  pictureRows,
  rateOfScene,
  rowsAt,
  sceneChoices,
  sceneLoops,
  sceneRates,
  sceneTick,
  thumbRows,
  wornScene,
} from '../hooks/scenes'

// The pane's scenes, as properties: every scene draws whole in half blocks at any width, the pet on it where it
// stands, a narrow pane keeping the pet in the middle; a loop moves only on its clock; and the choices list each owned
// scene once, a worn one the mod can't draw still there to take off.

const ids = Object.keys(sceneArt)
const Id = Schema.Literals(ids)
const Width = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 80 }))
const Tick = Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })))
const hex = /^#[0-9a-f]{6}$/

const owned = (itemId: string, entryId: string, category = 'scene'): OwnedItem => ({
  entryId,
  itemId,
  name: itemId,
  rarity: 'common',
  category,
  slot: category === 'scene' ? 'scene' : null,
  look: null,
  lore: null,
  sprite: itemId,
})

describe('a scene in the pane', () => {
  const title = 'draws in 12 rows of half blocks, as wide as the pane or the scene, in hex colors'
  prop.prop(title, [Id, Width, Tick], ([id, width, tick]) => {
    const art = sceneArt[id]
    if (art === undefined) throw new Error(id)
    const rows = pictureRows(art, tick, width)
    expect(rows).toHaveLength(sceneSize.height / 2)
    for (const row of rows) {
      expect(cellsOfRow(row)).toBe(Math.min(width, sceneSize.width))
      for (const run of row) {
        expect([...run.text].every((cell) => cell === '▀')).toBe(true)
        expect(run.color).toMatch(hex)
        expect(run.background).toMatch(hex)
      }
    }
  })

  it('stands the pet where the scene puts it, and keeps it in the middle of a narrow pane', () => {
    const art = sceneArt['clear-night']
    if (art === undefined) throw new Error('clear-night')
    const colorAt = (rows: ReturnType<typeof pictureRows>, x: number, y: number) => {
      const row = rows[Math.floor(y / 2)] ?? []
      const cells = row.flatMap((run) => [...run.text].map(() => (y % 2 === 0 ? run.color : run.background)))
      return cells[x]
    }
    const outline = petPixels.palette['o']
    const body = petPixels.palette['b']
    const whole = pictureRows(art, null, 48)
    // The pet's ear tip on its first row, and its body under it.
    expect(colorAt(whole, petInScene.x + 2, petInScene.y)).toBe(outline)
    expect(colorAt(whole, petInScene.x + 2, petInScene.y + 1)).toBe(body)
    const narrow = pictureRows(art, null, 20)
    const left = petInScene.x + 7 - 10
    expect(colorAt(narrow, petInScene.x + 2 - left, petInScene.y)).toBe(outline)
    // Before a hatch, the scene alone.
    const alone = pictureRows(art, null, 48, null)
    const behind = art.palette[art.rows[petInScene.y]?.[petInScene.x + 2] ?? '']
    expect(colorAt(alone, petInScene.x + 2, petInScene.y)).toBe(behind)
  })

  prop.prop('is small in the list: 16 cells by 4 rows', [Id, Tick], ([id, tick]) => {
    const art = sceneArt[id]
    if (art === undefined) throw new Error(id)
    const rows = thumbRows(art, tick)
    expect(rows).toHaveLength(4)
    for (const row of rows) expect(cellsOfRow(row)).toBe(16)
  })
})

describe('a scene that loops', () => {
  const looping = ids.filter((id) => sceneLoops(sceneArt[id] ?? null))

  it('is every legendary one, each within the band budget of 6 fps', () => {
    expect(looping.length).toBeGreaterThan(0)
    for (const id of looping) {
      const rate = rateOfScene(sceneArt[id] ?? null)
      expect(rate, id).toBeGreaterThan(0)
      expect(rate, id).toBeLessThanOrEqual(6)
    }
  })

  it('moves frame by frame on its clock, and holds still when the loops rest', () => {
    for (const id of looping) {
      const art = sceneArt[id]
      if (art === undefined) throw new Error(id)
      const rate = rateOfScene(art)
      expect(sceneTick(art, null), id).toBeNull()
      expect(rowsAt(art, null), id).toBe(art.rows)
      const at = (tick: number) => rowsAt(art, sceneTick(art, { ticks: { [String(rate)]: tick } }))
      const frames = (art.frames ?? []).map((_, tick) => at(tick))
      expect(new Set(frames.map((rows) => rows.join('/'))).size, id).toBeGreaterThan(1)
      // Every frame is the scene's size, and the pet's own cells never move.
      for (const rows of frames) {
        expect(rows.map((row) => row.length)).toEqual(art.rows.map((row) => row.length))
        expect(rows[petInScene.y + 5]?.slice(petInScene.x, petInScene.x + 14)).toBe(
          art.rows[petInScene.y + 5]?.slice(petInScene.x, petInScene.x + 14),
        )
      }
    }
  })

  it('loops in the pane only: a closed pane runs no clock for a scene', () => {
    const wardrobe: Wardrobe = { items: looping.map((id, i) => owned(id, `e${i}`)), equipped: { scene: 'e0' } }
    expect(sceneRates(wardrobe, false)).toEqual([])
    expect(sceneRates(wardrobe, true).length).toBeGreaterThan(0)
  })
})

describe('the scene choices', () => {
  it('list None first, then each owned scene once, rarest first, the worn one marked', () => {
    const lights: OwnedItem = { ...owned('northern-lights', 'c'), rarity: 'legendary' }
    const items = [owned('clear-night', 'a'), owned('clear-night', 'b'), lights]
    const choices = sceneChoices({ items, equipped: { scene: 'b' } })
    expect(choices.map((one) => [one.key, one.isWorn, one.entryId, one.count])).toEqual([
      ['none', false, null, 1],
      ['northern-lights', false, 'c', 1],
      ['clear-night', true, 'b', 2],
    ])
    expect(wornScene({ items, equipped: { scene: 'b' } })?.item.itemId).toBe('clear-night')
  })

  it('keep a worn scene the mod has no art for, to take off, and leave it among the other items', () => {
    const items = [owned('a-later-scene', 'z')]
    const wardrobe = { items, equipped: { scene: 'z' } }
    expect(artOf(owned('a-later-scene', 'z'))).toBeNull()
    expect(wornScene(wardrobe)).toBeNull()
    expect(sceneChoices(wardrobe).map((one) => [one.key, one.isWorn])).toEqual([
      ['none', false],
      ['lost', true],
    ])
    expect(otherItems(wardrobe).map((one) => one.itemId)).toEqual(['a-later-scene'])
  })

  it('take the scenes the mod draws out of the other items', () => {
    const wardrobe = { items: [owned('clear-night', 'a'), owned('honey-biscuit', 'b', 'food')], equipped: {} }
    expect(otherItems(wardrobe).map((one) => one.itemId)).toEqual(['honey-biscuit'])
  })
})
