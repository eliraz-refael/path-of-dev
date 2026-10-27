import type { Loop, OwnedItem, SceneArt, Sprite, Tier, Wardrobe } from '../types'
import type { Row, Run } from './cells'
import { tierRank } from './celebrate'
import { equippedIn, maxFps } from './looks'
import { petInScene, petPixels, sceneArt, sceneSize } from './scene-art'

// Scenes: the backdrop the pet stands in, pixel art the mod carries a copy of (scene-art.ts) and finds by the item's
// sprite. The pane draws the worn one whole, in half blocks, the pet on it, and each owned one small beside its
// Equip. A legendary scene loops on the band's loop clocks, as a band style does. The band itself draws no scene yet.

/** The half block: its glyph's color is a cell's upper pixel, its background the lower. */
const halfBlock = '▀'

/**
 * The art of an owned scene, by its sprite; null for anything else, or one with no sprite (Terminal Green under
 * catalogue 7) or none the mod has art for, as the profile page and the companion read it.
 */
export const artOf = (item: Pick<OwnedItem, 'category' | 'sprite'>): SceneArt | null =>
  item.category === 'scene' && item.sprite !== undefined ? (sceneArt[item.sprite] ?? null) : null

/** The scene worn, with its art; null with none worn, or one the mod can't draw. */
export const wornScene = (wardrobe: Wardrobe | null): { item: OwnedItem; art: SceneArt } | null => {
  const item = equippedIn(wardrobe, 'scene')
  const art = item === null ? null : artOf(item)
  return item === null || art === null ? null : { item, art }
}

/** Whether a scene loops: two frames or more, at a rate. */
export const sceneLoops = (art: SceneArt | null): boolean =>
  art !== null && (art.frames?.length ?? 0) > 1 && (art.fps ?? 0) > 0

/** The rate a scene loops at, within the band's budget; 0 for a still one. */
export const rateOfScene = (art: SceneArt | null): number =>
  art !== null && sceneLoops(art) ? Math.min(maxFps, art.fps ?? 0) : 0

/** The frames a scene has played on its rate's clock, or null when it is still or the loops rest. */
export const sceneTick = (art: SceneArt | null, loop: Loop | null): number | null => {
  const rate = rateOfScene(art)
  return loop === null || rate === 0 ? null : (loop.ticks[String(rate)] ?? null)
}

/** The rates the scenes drawn loop at: the pane's, every owned one's, while it is open. The band draws none. */
export const sceneRates = (wardrobe: Wardrobe | null, isPaneOpen: boolean): Array<number> =>
  isPaneOpen ? [...new Set((wardrobe?.items ?? []).map(artOf).map(rateOfScene).filter((rate) => rate > 0))] : []

/** The scene's rows at `tick`: its frame laid over it, `.` keeping the scene's cell, or the scene when it is still. */
export const rowsAt = (art: SceneArt, tick: number | null): ReadonlyArray<string> => {
  const frames = art.frames ?? []
  if (tick === null || !sceneLoops(art)) return art.rows
  const frame = frames[tick % frames.length] ?? []
  return art.rows.map((row, y) => {
    const over = frame[y]
    if (over === undefined) return row
    return [...row].map((cell, x) => (over[x] === undefined || over[x] === '.' ? cell : over[x])).join('')
  })
}

/** The colors of a scene's cells at `tick`, the pet's pixels laid on where it stands when `pet` is given. */
const pixelsOf = (art: SceneArt, tick: number | null, pet: Sprite | null): Array<Array<string>> => {
  const pixels = rowsAt(art, tick).map((row) => [...row].map((cell) => art.palette[cell] ?? '#000000'))
  pet?.rows.forEach((row, dy) =>
    [...row].forEach((cell, dx) => {
      const color = cell === '.' ? undefined : pet.palette[cell]
      const line = pixels[petInScene.y + dy]
      if (color !== undefined && line !== undefined) line[petInScene.x + dx] = color
    }),
  )
  return pixels
}

/** Runs of cells, each cell one glyph, joined where the style holds. */
const joined = (cells: ReadonlyArray<Run>): Row =>
  cells.reduce<Array<Run>>((runs, cell) => {
    const last = runs[runs.length - 1]
    const same =
      last !== undefined &&
      last.color === cell.color &&
      last.background === cell.background &&
      last.bold === cell.bold &&
      last.dim === cell.dim
    if (last !== undefined && same) last.text += cell.text
    else runs.push({ ...cell })
    return runs
  }, [])

/**
 * The scene at `tick` in half blocks, `columns` wide at most: the whole of it, 48 cells by 12 rows, the pet on it, or
 * as much as fits round the pet in a narrower pane. With `pet` null, the scene alone, as before a hatch.
 */
export const pictureRows = (
  art: SceneArt,
  tick: number | null,
  columns: number,
  pet: Sprite | null = petPixels,
): Array<Row> => {
  const pixels = pixelsOf(art, tick, pet)
  const width = Math.max(1, Math.min(sceneSize.width, columns))
  const middle = petInScene.x + Math.floor((petPixels.rows[0]?.length ?? 0) / 2)
  const left = Math.max(0, Math.min(sceneSize.width - width, middle - Math.floor(width / 2)))
  const rows: Array<Row> = []
  for (let y = 0; y < sceneSize.height; y += 2) {
    const upper = pixels[y] ?? []
    const lower = pixels[y + 1] ?? upper
    const cells = Array.from({ length: width }, (_, i): Run => ({
      text: halfBlock,
      color: upper[left + i] ?? '#000000',
      background: lower[left + i] ?? '#000000',
    }))
    rows.push(joined(cells))
  }
  return rows
}

/** One scene the pane offers: none (`entryId` null, the band as it comes), or an owned one. */
export type SceneChoice = {
  /** Stable for the Buttons' keys: the item id, `none`, or `lost`. */
  key: string
  name: string
  rarity: Tier | null
  /** The entry to equip: the one worn, else the first owned. */
  entryId: string | null
  count: number
  art: SceneArt | null
  lore: string | null
  isWorn: boolean
  isLooping: boolean
  /** What the pane says in place of a rarity. */
  note: string | null
}

/** The scenes the pane offers: none first, then one it can't draw that is worn, then the owned ones, rarest first. */
export const sceneChoices = (wardrobe: Wardrobe | null): Array<SceneChoice> => {
  const wornEntry = wardrobe?.equipped['scene']
  const byItem = new Map<string, SceneChoice>()
  for (const item of wardrobe?.items ?? []) {
    const art = artOf(item)
    if (art === null) continue
    const seen = byItem.get(item.itemId)
    const isWorn = item.entryId === wornEntry
    byItem.set(item.itemId, {
      key: item.itemId,
      name: item.name,
      rarity: item.rarity,
      entryId: isWorn || seen === undefined ? item.entryId : seen.entryId,
      count: (seen?.count ?? 0) + 1,
      art,
      lore: item.lore,
      isWorn: isWorn || (seen?.isWorn ?? false),
      isLooping: sceneLoops(art),
      note: null,
    })
  }
  const owned = [...byItem.values()].sort(
    (a, b) => tierRank(b.rarity ?? 'common') - tierRank(a.rarity ?? 'common') || a.name.localeCompare(b.name),
  )
  // A scene worn that the mod can't draw (one from a later catalogue, or none it knows) still shows, to take off.
  const lost: Array<SceneChoice> =
    wornEntry === undefined || owned.some((choice) => choice.isWorn)
      ? []
      : [
          {
            key: 'lost',
            name: 'Unknown scene',
            rarity: null,
            entryId: wornEntry,
            count: 1,
            art: null,
            lore: null,
            isWorn: true,
            isLooping: false,
            note: 'not one this mod can draw',
          },
        ]
  const none: SceneChoice = {
    key: 'none',
    name: 'None',
    rarity: null,
    entryId: null,
    count: 1,
    art: null,
    lore: null,
    isWorn: wornEntry === undefined,
    isLooping: false,
    note: "the terminal's own background",
  }
  return [none, ...lost, ...owned]
}

/** The still scenes' thumbs at the scale of 3, drawn once: the pane draws every owned one on each frame of a loop. */
const stillThumbs = new WeakMap<SceneArt, ReadonlyArray<Row>>()

/** A scene small, `scale` of its cells to a pixel, in half blocks: 16 cells by 4 rows at the scale of 3. */
export const thumbRows = (art: SceneArt, tick: number | null, scale = 3): ReadonlyArray<Row> => {
  const isStill = scale === 3 && (tick === null || !sceneLoops(art))
  const kept = isStill ? stillThumbs.get(art) : undefined
  if (kept !== undefined) return kept
  const rows = drawThumb(art, tick, scale)
  if (isStill) stillThumbs.set(art, rows)
  return rows
}

const drawThumb = (art: SceneArt, tick: number | null, scale: number): Array<Row> => {
  const pixels = pixelsOf(art, tick, null)
  const at = (x: number, y: number) => pixels[y * scale + Math.floor(scale / 2)]?.[x * scale + Math.floor(scale / 2)]
  const width = Math.floor(sceneSize.width / scale)
  const height = Math.floor(sceneSize.height / scale)
  const rows: Array<Row> = []
  for (let y = 0; y < height; y += 2) {
    const cells = Array.from({ length: width }, (_, x): Run => ({
      text: halfBlock,
      color: at(x, y) ?? '#000000',
      background: at(x, y + 1) ?? at(x, y) ?? '#000000',
    }))
    rows.push(joined(cells))
  }
  return rows
}
