import { petSprite } from '@pathofdev/schema'
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// What the companion (crates/pathofdev, in Rust) embeds of the mod's drawing, written here so no Rust copy can drift:
//
//   crates/pathofdev/assets/sprite.json   the pet's pixels and palette, `petSprite`, which the companion draws in half
//                                          blocks
//
// The asset lives inside the crate, not in contract/, because the binary embeds it and a crate can't reach outside its
// own directory. A file that differs means the drawing changed: run `pnpm contract` to write it again.

const writing = process.env['PATHOFDEV_WRITE_CONTRACT'] === '1'
const assets = new URL('../../../crates/pathofdev/assets/', import.meta.url)

const textOf = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

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
