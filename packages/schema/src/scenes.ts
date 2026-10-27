import { maxLoopFps } from "./domain.ts"
import type { Sprite } from "./sprites.ts"
import { dressedSize, emptyCell, petAt, petSprite } from "./sprites.ts"

// A scene: the backdrop the pet stands in, pixel art twice as wide as tall, every cell filled. The profile page, the
// companion and the mod's pane draw it whole with the pet on it; the band draws none yet. A legendary one loops: each
// frame lays a few cells over the scene, never near the pet.
//
//   ┌──────────────────────── 48 ────────────────────────┐
//   │ sky, scenery                                        │
//   │               ┌ the pet's quiet box ┐               │ 24
//   │  scenery      │  the pet at (17, 11) │   scenery     │
//   │               │  its feet on row 22  │               │
//   └───────────────┴──────────────────────┴───────────────┘
//
// Every renderer reads the same rows: `sceneRowsAt` for a loop's frame, `sceneWithPet` for the scene and the pet as
// one sprite. `sceneIssue` is what the catalogue's tests hold every scene to: the right size, a palette that covers
// it, a pet that stands out of it in truecolor and in xterm's 256, and calm and stillness round the pet.

/** A scene's size in cells: in half blocks, 48 columns and 12 rows of a terminal. */
export const sceneSize = { width: 48, height: 24 } as const

/** Where the pet's own top-left cell sits on a scene: in the middle, its feet on the row above the last. */
export const petInScene = { x: 17, y: 11 } as const

/** Where a dressed pet's canvas (`dressedSize`) sits on a scene, so the pet in it lands at `petInScene`. */
export const dressedInScene = { x: petInScene.x - petAt.x, y: petInScene.y - petAt.y } as const

/** A scene's art: its rows of letters and their colours, and for a loop its frames and their rate. */
export interface SceneArt {
  readonly rows: ReadonlyArray<string>
  readonly palette: Readonly<Record<string, string>>
  /** Laid over `rows` in turn, `.` where a frame keeps the scene's cell. Only a scene that loops has them. */
  readonly frames?: ReadonlyArray<ReadonlyArray<string>>
  /** Frames a second while it loops. */
  readonly fps?: number
}

/** The most colours one scene, its frames included, may use. */
export const maxSceneColors = 32
/** The most frames a loop may have. */
export const maxSceneFrames = 16
/** The most colours the cells round the pet (`calmCells`) may hold between them: past it, the pet stands in clutter. */
export const maxCalmColors = 8
/** How far a pet's outline must stand out of what touches it: the WCAG ratio, in truecolor and in xterm's 256. */
export const minPetContrast = { truecolor: 3, xterm: 2.5 } as const

/** Whether a scene loops: two frames or more, at a rate. */
export const sceneLoops = (art: SceneArt): boolean =>
  (art.frames?.length ?? 0) > 1 && art.fps !== undefined && art.fps > 0

/** The scene's rows at the loop's `tick`: its frame laid over the scene, or the scene itself when it is still. */
export const sceneRowsAt = (art: SceneArt, tick: number | null): ReadonlyArray<string> => {
  const frames = art.frames ?? []
  if (tick === null || !sceneLoops(art)) return art.rows
  const frame = frames[((tick % frames.length) + frames.length) % frames.length] ?? []
  return art.rows.map((row, y) => {
    const over = frame[y]
    if (over === undefined || !over.split("").some((cell) => cell !== emptyCell)) return row
    return [...row].map((cell, x) => (over[x] === undefined || over[x] === emptyCell ? cell : over[x])).join("")
  })
}

/** The letters a composed sprite names its colours with, in the order it meets them. */
const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

/** Colours as letters again, each colour one letter. */
const lettered = (canvas: ReadonlyArray<ReadonlyArray<string | null>>): Sprite => {
  const named = new Map<string, string>()
  const rows = canvas.map((line) =>
    line.map((color) => {
      if (color === null) return emptyCell
      const known = named.get(color)
      if (known !== undefined) return known
      const letter = letters[named.size] ?? letters[letters.length - 1]!
      named.set(color, letter)
      return letter
    }).join("")
  )
  return { rows, palette: Object.fromEntries([...named].map(([color, letter]) => [letter, color])) }
}

/**
 * The scene at `tick` with `pet` standing on it, as one sprite the scene's size: the plain pet (`petSprite`) at
 * `petInScene`, or a dressed one (`dressedSize`) at `dressedInScene`, its empty cells showing the scene.
 */
export const sceneWithPet = (art: SceneArt, pet: Sprite = petSprite, tick: number | null = null): Sprite => {
  const canvas = sceneRowsAt(art, tick).map((row) => [...row].map((cell): string | null => art.palette[cell] ?? null))
  const at = pet.rows.length === dressedSize.height ? dressedInScene : petInScene
  pet.rows.forEach((row, dy) =>
    [...row].forEach((cell, dx) => {
      const color = cell === emptyCell ? undefined : pet.palette[cell]
      const line = canvas[at.y + dy]
      if (color !== undefined && line !== undefined && at.x + dx < line.length) line[at.x + dx] = color
    })
  )
  return lettered(canvas)
}

// What the checks read: where the pet's cells are on a scene, the cells that touch it, and those within two of it.

const petCells: ReadonlyArray<{ readonly x: number; readonly y: number }> = petSprite.rows.flatMap((row, y) =>
  [...row].flatMap((cell, x) => (cell === emptyCell ? [] : [{ x: petInScene.x + x, y: petInScene.y + y }]))
)
const isPetCell = (x: number, y: number): boolean => petCells.some((cell) => cell.x === x && cell.y === y)

/** The scene's cells within `reach` of the pet, all eight ways round, the pet's own left out. */
const cellsWithin = (reach: number): ReadonlyArray<{ readonly x: number; readonly y: number }> => {
  const seen = new Set<string>()
  const cells: Array<{ x: number; y: number }> = []
  for (const pet of petCells) {
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const x = pet.x + dx
        const y = pet.y + dy
        const key = `${x},${y}`
        const outside = x < 0 || y < 0 || x >= sceneSize.width || y >= sceneSize.height
        if (outside || seen.has(key) || isPetCell(x, y)) continue
        seen.add(key)
        cells.push({ x, y })
      }
    }
  }
  return cells
}

/** The cells touching the pet's outline: what the pet must stand out of. */
export const edgeCells = cellsWithin(1)
/** The cells within two of the pet: kept calm, a few colours and no motion. */
export const calmCells = cellsWithin(2)

/** Whether a cell is in the dressed pet's box, where its wear may be drawn: a loop never moves a cell there. */
const inQuietBox = (x: number, y: number): boolean =>
  x >= dressedInScene.x &&
  x < dressedInScene.x + dressedSize.width &&
  y >= dressedInScene.y &&
  y < dressedInScene.y + dressedSize.height

// Colour, as the checks measure it: the WCAG contrast ratio, and the nearest of xterm's 256, which the companion falls
// back to.

const channels = (hex: string): readonly [number, number, number] => {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

const luminance = (hex: string): number => {
  const [r, g, b] = channels(hex).map((channel) => {
    const s = channel / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

/** The WCAG contrast ratio of two `#rrggbb` colours: 1 for the same, 21 for black on white. */
export const contrastRatio = (a: string, b: string): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light! + 0.05) / (dark! + 0.05)
}

const cube: ReadonlyArray<number> = [0, 95, 135, 175, 215, 255]
const toHex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`

/**
 * The nearest of xterm's 256 colours to `hex`, the 6×6×6 cube or the 24 greys, as the companion paints a terminal
 * that doesn't draw 24-bit colour (crates/pathofdev/src/ui/theme.rs, `xterm_256`, does the same).
 */
export const nearestXterm = (hex: string): string => {
  const [r, g, b] = channels(hex)
  const level = (channel: number) =>
    cube.reduce((best, step, i) => (Math.abs(step - channel) < Math.abs(cube[best]! - channel) ? i : best), 0)
  const inCube = [cube[level(r)]!, cube[level(g)]!, cube[level(b)]!] as const
  const grey = 8 + 10 * Math.min(23, Math.floor(Math.max(0, Math.floor((r + g + b) / 3) - 3) / 10))
  const distance = ([x, y, z]: readonly [number, number, number]) => (x - r) ** 2 + (y - g) ** 2 + (z - b) ** 2
  return distance([grey, grey, grey]) < distance(inCube) ? toHex(grey, grey, grey) : toHex(...inCube)
}

/** How far `color` stands out of the pet's outline or its body, whichever is more. */
const standsOut = (color: string, paint: (hex: string) => string = (hex) => hex): number => {
  const outline = petSprite.palette["o"] ?? "#000000"
  const body = petSprite.palette["b"] ?? "#ffffff"
  return Math.max(contrastRatio(paint(color), paint(outline)), contrastRatio(paint(color), paint(body)))
}

const isHex = (color: string): boolean => /^#[0-9a-f]{6}$/u.test(color)

/**
 * What is wrong with a scene's art, if anything: its size, a letter with no colour or a colour no letter uses, too
 * many colours, a loop out of its budget or moving a cell round the pet, clutter round the pet, or a cell touching the
 * pet that it can't be told from, in truecolor or in xterm's 256.
 */
export const sceneIssue = (art: SceneArt): string | undefined => {
  const { width, height } = sceneSize
  if (art.rows.length !== height || art.rows.some((row) => [...row].length !== width)) {
    return `a scene is ${width} by ${height} cells`
  }
  const bad = Object.entries(art.palette).find(([letter, color]) => [...letter].length !== 1 || !isHex(color))
  if (bad !== undefined) return `"${bad[0]}" is no letter and colour: ${bad[1]}`
  const frames = art.frames ?? []
  const used = new Set([...art.rows.join(""), ...frames.flatMap((frame) => [...frame.join("")])])
  used.delete(emptyCell)
  if (art.rows.some((row) => row.includes(emptyCell))) return "a scene fills every cell"
  const unpainted = [...used].find((letter) => art.palette[letter] === undefined)
  if (unpainted !== undefined) return `"${unpainted}" has no colour`
  const unused = Object.keys(art.palette).find((letter) => !used.has(letter))
  if (unused !== undefined) return `"${unused}" is never drawn`
  if (Object.keys(art.palette).length > maxSceneColors) return `a scene has at most ${maxSceneColors} colours`
  if ((art.frames === undefined) !== (art.fps === undefined)) return "a loop needs both frames and a rate"
  if (art.fps !== undefined && !(art.fps >= 1 && art.fps <= maxLoopFps)) return `a loop runs at 1 to ${maxLoopFps} fps`
  if (art.frames !== undefined && (frames.length < 2 || frames.length > maxSceneFrames)) {
    return `a loop has 2 to ${maxSceneFrames} frames`
  }
  for (const frame of frames) {
    if (frame.length !== height || frame.some((row) => [...row].length !== width)) return "a frame is the scene's size"
  }
  const calm = new Set(calmCells.map(({ x, y }) => `${x},${y}`))
  for (const [i, frame] of frames.entries()) {
    for (const [y, row] of frame.entries()) {
      const moved = [...row].findIndex((cell, x) => cell !== emptyCell && (calm.has(`${x},${y}`) || inQuietBox(x, y)))
      if (moved >= 0) return `frame ${i} moves ${moved},${y}, by the pet`
    }
  }
  const colorAt = (x: number, y: number) => art.palette[[...(art.rows[y] ?? "")][x] ?? emptyCell] ?? "#000000"
  const calmColors = new Set(calmCells.map(({ x, y }) => colorAt(x, y)))
  if (calmColors.size > maxCalmColors) return `${calmColors.size} colours round the pet, past ${maxCalmColors}`
  for (const { x, y } of edgeCells) {
    const color = colorAt(x, y)
    if (standsOut(color) < minPetContrast.truecolor) return `the pet can't be told from ${color} at ${x},${y}`
    if (standsOut(color, nearestXterm) < minPetContrast.xterm) {
      return `in 256 colours, the pet can't be told from ${color} at ${x},${y}`
    }
  }
  return undefined
}
