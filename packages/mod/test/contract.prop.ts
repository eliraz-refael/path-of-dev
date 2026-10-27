import { starterCatalog, starterSceneArt } from '@pathofdev/engine'
import type { SceneArt } from '@pathofdev/schema'
import { petInScene, petSprite, sceneIssue, sceneSize } from '@pathofdev/schema'
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// What the companion (crates/pathofdev, in Rust) embeds of the mod's drawing, written here so no Rust copy can drift:
//
//   crates/pathofdev/assets/sprite.json   the pet's pixels and palette, `petSprite`, which the companion draws in half
//                                          blocks
//   crates/pathofdev/assets/scenes.json   every scene's art by its sprite id (the engine's `starterSceneArt`), with
//                                          its size and where the pet stands on it
//
// And what the mod embeds of the same, since it loads none of the TypeScript packages when it runs:
//
//   packages/mod/hooks/scene-art.ts        the scenes and the pet's pixels, as a module of the mod's own
//
// The asset lives inside the crate, not in contract/, because the binary embeds it and a crate can't reach outside its
// own directory. A file that differs means the drawing changed: run `pnpm contract` to write it again.

const writing = process.env['PATHOFDEV_WRITE_CONTRACT'] === '1'
const assets = new URL('../../../crates/pathofdev/assets/', import.meta.url)

const textOf = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

/** The scenes as the companion reads them: their size, where the pet stands, and each one's art by its sprite id. */
const scenes = { size: sceneSize, pet: petInScene, scenes: starterSceneArt }

/** A string as the mod writes one: single quotes. Art holds only letters, dots and colours, which need no escapes. */
const quoted = (text: string): string => `'${text}'`

const artText = (art: SceneArt): string => {
  const palette = Object.entries(art.palette).map(([letter, color]) => `${letter}: ${quoted(color)}`)
  const rows = (lines: ReadonlyArray<string>, pad: string) => lines.map((row) => `${pad}${quoted(row)},`).join('\n')
  const frame = (one: ReadonlyArray<string>) => `      [\n${rows(one, '        ')}\n      ],`
  const frames =
    art.frames === undefined
      ? ''
      : `    frames: [\n${art.frames.map(frame).join('\n')}\n    ],\n    fps: ${art.fps ?? 1},\n`
  const line = `    palette: { ${palette.join(', ')} },`
  // A palette too long for a line takes one line for every six of its colours.
  const lines = Array.from({ length: Math.ceil(palette.length / 6) }, (_, i) => palette.slice(i * 6, i * 6 + 6))
  const long = `    palette: {\n${lines.map((some) => `      ${some.join(', ')},`).join('\n')}\n    },`
  return `{\n${line.length <= 120 ? line : long}\n    rows: [\n${rows(art.rows, '      ')}\n    ],\n${frames}  }`
}

const petPalette = Object.entries(petSprite.palette)
  .map(([letter, color]) => `${letter}: ${quoted(color)}`)
  .join(', ')

/** The mod's copy of the scenes and the pet, written as the module hooks/scene-art.ts. */
const modText = (): string =>
  [
    `import type { Sprite, SceneArt } from '../types'`,
    ``,
    `// Written by packages/mod/test/contract.prop.ts from the engine's scenes and the schema's pet: run`,
    `// \`pnpm contract\` after changing either, never this file.`,
    ``,
    `/** A scene's size in cells, and the cell the pet's own top-left one stands on. */`,
    `export const sceneSize = { width: ${sceneSize.width}, height: ${sceneSize.height} }`,
    `export const petInScene = { x: ${petInScene.x}, y: ${petInScene.y} }`,
    ``,
    `/** The pet's pixels, as the profile page and the companion draw it. */`,
    `export const petPixels: Sprite = {`,
    `  rows: [\n${petSprite.rows.map((row) => `    ${quoted(row)},`).join('\n')}\n  ],`,
    `  palette: { ${petPalette} },`,
    `}`,
    ``,
    `/** Every scene's art, by its sprite id. */`,
    `export const sceneArt: Readonly<Record<string, SceneArt>> = {`,
    ...Object.entries(starterSceneArt).map(([id, art]) => `  ${quoted(id)}: ${artText(art)},`),
    `}`,
    ``,
  ].join('\n')

/** Writes `value` to `name` under the crate's assets when writing, else holds it equal to the committed file. */
const pin = (name: string, value: unknown) => {
  const file = new URL(name, assets)
  if (writing) writeFileSync(file, textOf(value))
  const pinned = readFileSync(file, 'utf8')
  expect(textOf(value), `crates/pathofdev/assets/${name} is out of date: run pnpm contract`).toBe(pinned)
}

describe('what the companion embeds', () => {
  it('is the pet as the schema draws it', () => {
    // Every row as wide as the first, and every letter in it but the empty one has a colour.
    const width = petSprite.rows[0]?.length ?? 0
    expect(petSprite.rows.every((row) => row.length === width)).toBe(true)
    const letters = new Set([...petSprite.rows.join('')].filter((letter) => letter !== '.'))
    expect([...letters].filter((letter) => petSprite.palette[letter] === undefined)).toEqual([])
    pin('sprite.json', petSprite)
  })
})

describe('the scenes', () => {
  it('are every scene in the catalogue, each one whole, for the companion and the mod alike', () => {
    const scenery = starterCatalog.filter((item) => item.category === 'scene')
    const ids = scenery.flatMap((item) => (item.sprite === null ? [] : [item.sprite]))
    expect(Object.keys(starterSceneArt).sort()).toEqual([...ids].sort())
    for (const [id, art] of Object.entries(starterSceneArt)) expect(sceneIssue(art), id).toBeUndefined()
    pin('scenes.json', scenes)
    const file = new URL('../hooks/scene-art.ts', import.meta.url)
    if (writing) writeFileSync(file, modText())
    const stale = 'packages/mod/hooks/scene-art.ts is out of date: run pnpm contract'
    expect(modText(), stale).toBe(readFileSync(file, 'utf8'))
  })
})
