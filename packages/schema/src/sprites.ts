import type { PetSlot } from "./primitives.ts"

// The pixel pet, as the landing page (site/index.html) and the profile pages draw it: a grid of cells, one letter
// each, "." for none, and a colour per letter. The site keeps its own copy, since it is a static page with no build;
// engine/test/site.test.ts checks the two stay the same.
//
//   rows ─▶ spriteRuns ─▶ [{x, y, width, cell}]   each row's runs of one letter, "." left out
//                            └─▶ one <rect> each, filled from the palette (server/html.ts spriteSvg)

/** A sprite: its rows, each the same length, and the colour of each letter they use. */
export interface Sprite {
  readonly rows: ReadonlyArray<string>
  readonly palette: Readonly<Record<string, string>>
}

/** The pet, 14 by 12: every species draws as it for now. */
export const petSprite: Sprite = {
  rows: [
    "..o........o..",
    ".obo......obo.",
    ".obbo....obbo.",
    ".obbboooobbbo.",
    "obbbbbbbbbbbbo",
    "obbewbbbbewbbo",
    "obbeebbbbeebbo",
    "obcbbbbbbbbcbo",
    "obbbbllllbbbbo",
    ".obbbllllbbbo.",
    "..obbbbbbbbo..",
    "...oo....oo...",
  ],
  palette: { o: "#2a1f4a", b: "#9d8cff", l: "#d9d0ff", e: "#14101f", w: "#ffffff", c: "#ff8fb1" },
}

/** The letter of a cell with nothing drawn. */
export const emptyCell = "."

/** A run of cells of one letter along a row. */
export interface SpriteRun {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly cell: string
}

/** Each row's runs of one letter, left to right and top to bottom; empty cells make none. */
export const spriteRuns = (rows: ReadonlyArray<string>): ReadonlyArray<SpriteRun> =>
  rows.flatMap((row, y) =>
    [...row.matchAll(/(.)\1*/gsu)].flatMap((match) =>
      match[1] === emptyCell ? [] : [{ x: match.index, y, width: match[0].length, cell: match[1]! }]
    )
  )

// The pet in its gear: what it wears on the five pet slots, drawn around it on a larger canvas, as the profile page
// shows a pet that wears anything (a pet that wears nothing is drawn as `petSprite`, cell for cell).
//
//   aura, back ─▶ behind the pet: they show only where the pet has no cell
//   pet ───────▶ petSprite at `petAt`
//   neck, head, hand ─▶ over it
//
// Each piece's art is a patch of cells at its place on the canvas, in a palette of its own. The canvas they make is
// one sprite again, its letters assigned colour by colour, so it draws as any sprite does.

/** The canvas a dressed pet is drawn on: room above for a hat, beside for wings and what it holds, below for a glow. */
export const dressedSize = { width: 20, height: 17 } as const

/** Where the pet's top-left cell sits on that canvas. */
export const petAt = { x: 3, y: 4 } as const

/** A piece of pet wear's art: its rows, `.` for none, placed with their top-left cell at `x`, `y` on the canvas. */
export interface WearArt {
  readonly x: number
  readonly y: number
  readonly rows: ReadonlyArray<string>
  readonly palette: Readonly<Record<string, string>>
}

/** The slots drawn behind the pet, then those drawn over it, each in the order it is drawn. */
export const wearBehind: ReadonlyArray<PetSlot> = ["aura", "back"]
export const wearOver: ReadonlyArray<PetSlot> = ["neck", "head", "hand"]

/** The letters a composed sprite names its colours with, in the order it meets them. */
const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

type Canvas = Array<Array<string | null>>

const paint = (canvas: Canvas, x0: number, y0: number, rows: ReadonlyArray<string>, palette: Sprite["palette"]) => {
  rows.forEach((row, dy) =>
    [...row].forEach((cell, dx) => {
      const color = cell === emptyCell ? undefined : palette[cell]
      const line = canvas[y0 + dy]
      if (color !== undefined && line !== undefined && x0 + dx >= 0 && x0 + dx < line.length) line[x0 + dx] = color
    })
  )
}

/**
 * The pet wearing `worn`, one piece a slot (a later one for a slot draws over an earlier), as one sprite the size of
 * `dressedSize`.
 */
export const dressedPet = (worn: ReadonlyArray<{ readonly slot: PetSlot; readonly art: WearArt }>): Sprite => {
  const { width, height } = dressedSize
  const canvas: Canvas = Array.from({ length: height }, () => Array.from({ length: width }, () => null))
  const layer = (slots: ReadonlyArray<PetSlot>) => {
    for (const slot of slots) {
      for (const { art } of worn.filter((piece) => piece.slot === slot)) {
        paint(canvas, art.x, art.y, art.rows, art.palette)
      }
    }
  }
  layer(wearBehind)
  paint(canvas, petAt.x, petAt.y, petSprite.rows, petSprite.palette)
  layer(wearOver)
  const named = new Map<string, string>()
  const rows = canvas.map((line) =>
    line.map((color) => {
      if (color === null) return emptyCell
      const known = named.get(color)
      if (known !== undefined) return known
      // Past the 62 letters, a colour takes a letter of its own from Latin-1 on: one UTF-16 unit, never ".".
      const letter = letters[named.size] ?? String.fromCharCode(0xc0 + named.size - letters.length)
      named.set(color, letter)
      return letter
    }).join("")
  )
  return { rows, palette: Object.fromEntries([...named].map(([color, letter]) => [letter, color])) }
}

/** The cells just outside the pet's outline on the canvas, all eight ways round: where an aura glows. */
export const haloCells: ReadonlyArray<{ readonly x: number; readonly y: number }> = (() => {
  const isPet = (x: number, y: number) => {
    const row = petSprite.rows[y - petAt.y]
    const cell = row?.[x - petAt.x]
    return cell !== undefined && cell !== emptyCell
  }
  const cells: Array<{ x: number; y: number }> = []
  for (let y = 0; y < dressedSize.height; y++) {
    for (let x = 0; x < dressedSize.width; x++) {
      if (isPet(x, y)) continue
      const near = [-1, 0, 1].some((dy) => [-1, 0, 1].some((dx) => isPet(x + dx, y + dy)))
      if (near) cells.push({ x, y })
    }
  }
  return cells
})()
