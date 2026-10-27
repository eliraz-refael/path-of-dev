import { describe, expect, it } from "vitest"
import type { SceneArt } from "../src/index.ts"
import {
  calmCells,
  contrastRatio,
  dressedPet,
  dressedSize,
  edgeCells,
  nearestXterm,
  petInScene,
  petSprite,
  sceneIssue,
  sceneRowsAt,
  sceneSize,
  sceneWithPet,
} from "../src/index.ts"

// What every scene is held to, from art that breaks each rule in turn: a plain scene passes, and each change to it
// that a renderer couldn't draw well, or that would lose the pet in it, is named.

const { width, height } = sceneSize
const fill = (letter: string) => Array.from({ length: height }, () => letter.repeat(width))
/** A plain dark scene: the pet's outline and body stand out of it. */
const plain: SceneArt = { rows: fill("a"), palette: { a: "#101018" } }
/** `art` with the cell at x, y painted `letter`. */
const withCell = (art: SceneArt, x: number, y: number, letter: string): ReadonlyArray<string> =>
  art.rows.map((row, i) => (i === y ? `${row.slice(0, x)}${letter}${row.slice(x + 1)}` : row))
const blankFrame = () => fill(".")

describe("a scene's art", () => {
  it("passes when whole, in its palette, and calm and clear round the pet", () => {
    expect(sceneIssue(plain)).toBeUndefined()
  })

  it("is the scene's size, every cell filled and painted, every colour used", () => {
    expect(sceneIssue({ ...plain, rows: plain.rows.slice(1) })).toMatch(/48 by 24/)
    expect(sceneIssue({ ...plain, rows: withCell(plain, 0, 0, ".") })).toMatch(/fills every cell/)
    expect(sceneIssue({ ...plain, rows: withCell(plain, 0, 0, "z") })).toMatch(/"z" has no colour/)
    expect(sceneIssue({ ...plain, palette: { ...plain.palette, q: "#123456" } })).toMatch(/"q" is never drawn/)
    expect(sceneIssue({ ...plain, palette: { a: "red" } })).toMatch(/no letter and colour/)
  })

  it("loses no pet: a cell touching it must stand out of its outline or body, in truecolor and in 256 colours", () => {
    const edge = edgeCells[0]!
    const grey = { ...plain, rows: withCell(plain, edge.x, edge.y, "m"), palette: { ...plain.palette, m: "#4a3f78" } }
    expect(sceneIssue(grey)).toMatch(/can't be told from #4a3f78/)
  })

  it("keeps few colours round the pet", () => {
    // Nine dark colours a cell each, two cells out from the pet, where nothing touches it.
    const isEdge = (x: number, y: number) => edgeCells.some((cell) => cell.x === x && cell.y === y)
    const cells = calmCells.filter(({ x, y }) => !isEdge(x, y)).slice(0, 9)
    const letters = [..."bcdefghij"]
    const rows = cells.reduce((art, { x, y }, i) => withCell({ ...plain, rows: art }, x, y, letters[i]!), plain.rows)
    const palette = Object.fromEntries([["a", "#101018"], ...letters.map((letter, i) => [letter, `#10${i}0${i}0`])])
    expect(sceneIssue({ rows, palette })).toMatch(/10 colours round the pet, past 8/)
  })

  it("loops in a budget, and never moves a cell by the pet", () => {
    const far = blankFrame().map((row, y) => (y === 0 ? `b${row.slice(1)}` : row))
    const looping: SceneArt = { ...plain, palette: { ...plain.palette, b: "#ffffff" }, frames: [far, blankFrame()], fps: 4 }
    expect(sceneIssue(looping)).toBeUndefined()
    const { fps: _, ...rateless } = looping
    expect(sceneIssue(rateless)).toMatch(/both frames and a rate/)
    expect(sceneIssue({ ...looping, fps: 12 })).toMatch(/1 to 6 fps/)
    expect(sceneIssue({ ...looping, frames: [far] })).toMatch(/2 to 16 frames/)
    const near = blankFrame().map((row, y) => (y === petInScene.y + 6 ? `${row.slice(0, 16)}b${row.slice(17)}` : row))
    expect(sceneIssue({ ...looping, frames: [near, blankFrame()] })).toMatch(/moves 16,17, by the pet/)
  })

  it("plays its frames over the scene, `.` keeping a cell, and holds still with no tick", () => {
    const far = blankFrame().map((row, y) => (y === 0 ? `b${row.slice(1)}` : row))
    const looping: SceneArt = { ...plain, palette: { ...plain.palette, b: "#ffffff" }, frames: [far, blankFrame()], fps: 4 }
    expect(sceneRowsAt(looping, null)).toBe(looping.rows)
    expect(sceneRowsAt(looping, 0)[0]).toBe(`b${"a".repeat(width - 1)}`)
    expect(sceneRowsAt(looping, 1)).toEqual(looping.rows)
    expect(sceneRowsAt(looping, 2)[0]?.[0]).toBe("b")
  })
})

describe("a scene with the pet on it", () => {
  const colourAt = (sprite: ReturnType<typeof sceneWithPet>, x: number, y: number) =>
    sprite.palette[sprite.rows[y]?.[x] ?? ""]

  it("stands the plain pet at its place, and keeps the scene everywhere else", () => {
    const drawn = sceneWithPet(plain)
    expect(drawn.rows).toHaveLength(height)
    expect(colourAt(drawn, petInScene.x + 2, petInScene.y)).toBe(petSprite.palette["o"])
    expect(colourAt(drawn, petInScene.x, petInScene.y)).toBe("#101018")
    expect(colourAt(drawn, 0, 0)).toBe("#101018")
  })

  it("stands a dressed pet so the pet in it lands at the same place", () => {
    const dressed = dressedPet([])
    expect(dressed.rows).toHaveLength(dressedSize.height)
    const drawn = sceneWithPet(plain, dressed)
    expect(colourAt(drawn, petInScene.x + 2, petInScene.y)).toBe(petSprite.palette["o"])
  })
})

describe("colour", () => {
  it("measures contrast as WCAG does", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5)
    expect(contrastRatio("#777777", "#777777")).toBe(1)
  })

  it("finds the nearest of xterm's 256 as the companion does: the cube, or a grey", () => {
    expect(nearestXterm("#ffffff")).toBe("#ffffff")
    expect(nearestXterm("#000000")).toBe("#000000")
    expect(nearestXterm("#ff0000")).toBe("#ff0000")
    expect(nearestXterm("#808080")).toBe("#808080")
    expect(nearestXterm("#5a7aa8")).toBe("#5f87af")
  })
})
