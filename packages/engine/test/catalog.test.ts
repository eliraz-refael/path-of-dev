import { it } from "@effect/vitest"
import type { ItemDef, PetSlot, Rarity } from "@pathofdev/schema"
import {
  bandParts,
  dressedPet,
  dressedSize,
  emptyCell,
  ItemDef as ItemDefSchema,
  Pity,
  Rarity as RaritySchema,
  wearBehind,
} from "@pathofdev/schema"
import { readFileSync } from "node:fs"
import { Schema } from "effect"
import { describe, expect } from "vitest"
import {
  catalog6,
  isSigil,
  isXpFood,
  rollLoot,
  rules14,
  starterCatalog,
  starterRules,
  starterWear,
  starterWearArt,
} from "../src/index.ts"

// Catalogue 7, the bigger pool rules 15 deals from: every item well formed and drawn, a pyramid of rarities, and the
// same odds as catalogue 6, which rules 14 dealt from and which stays as it shipped.

const rarities = RaritySchema.literals
const petSlots: ReadonlyArray<PetSlot> = ["head", "neck", "back", "hand", "aura"]
const ofRarity = (catalog: ReadonlyArray<ItemDef>, rarity: Rarity) => catalog.filter((item) => item.rarity === rarity)

/** Whether a glyph takes two cells, by the mod's rule (hooks/cells.ts), which a band style's parts must not. */
const isWide = (glyph: string): boolean => {
  const code = glyph.codePointAt(0) ?? 0
  return (
    glyph.includes("️") ||
    code >= 0x1f000 ||
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xff60)
  )
}

describe("catalogue 7", () => {
  it("is 113 items, each well formed, with an id and a name of its own and a line of lore", () => {
    expect(starterCatalog).toHaveLength(113)
    for (const item of starterCatalog) expect(Schema.decodeUnknownSync(ItemDefSchema)(item)).toEqual(item)
    expect(new Set(starterCatalog.map((item) => item.id)).size).toBe(starterCatalog.length)
    expect(new Set(starterCatalog.map((item) => item.name.toLowerCase())).size).toBe(starterCatalog.length)
    for (const item of starterCatalog.filter((one) => one.category !== "bandStyle" || one.lore !== null)) {
      expect(item.lore, item.id).toMatch(/^[A-Z"].{8,58}[.!?]$/u)
    }
  })

  it("keeps every item of catalogue 6, by the same name, rarity, kind and slot, as players own them", () => {
    for (const old of catalog6) {
      const item = starterCatalog.find((one) => one.id === old.id)
      expect(item, old.id).toMatchObject({ name: old.name, rarity: old.rarity, category: old.category, slot: old.slot })
      expect({ effect: item?.effect, look: item?.look, sigil: item?.sigil }).toEqual({
        effect: old.effect,
        look: old.look,
        sigil: old.sigil,
      })
    }
  })

  it("is a pyramid: each rarity has fewer items than the one below it", () => {
    const counts = rarities.map((rarity) => ofRarity(starterCatalog, rarity).length)
    expect(counts).toEqual([39, 28, 21, 14, 11])
    for (let i = 1; i < counts.length; i++) expect(counts[i]!).toBeLessThan(counts[i - 1]!)
  })

  it("fills every pet slot at the common end, and each band slot at every rarity a style had there", () => {
    for (const slot of petSlots) {
      expect(starterCatalog.some((item) => item.slot === slot && item.rarity === "common"), slot).toBe(true)
    }
    for (const slot of Object.keys(bandParts)) {
      const before = new Set(catalog6.filter((item) => item.slot === slot).map((item) => item.rarity))
      const now = new Set(starterCatalog.filter((item) => item.slot === slot).map((item) => item.rarity))
      expect([...before].every((rarity) => now.has(rarity)), slot).toBe(true)
      expect(now.size, slot).toBeGreaterThanOrEqual(before.size)
    }
  })

  it("keeps XP food the share of each rarity's other drops it was in catalogue 6", () => {
    for (const rarity of rarities) {
      const share = (catalog: ReadonlyArray<ItemDef>) => {
        const others = ofRarity(catalog, rarity).filter((item) => !isSigil(item))
        return others.filter(isXpFood).length / others.length
      }
      expect(share(starterCatalog), rarity).toBeCloseTo(share(catalog6), 9)
    }
  })

  it("draws its band styles with one-cell glyphs, but the two-letter `lv`", () => {
    for (const item of starterCatalog.filter((one) => one.look !== null)) {
      const glyphs = [
        ...Object.entries(item.look?.glyphs ?? {}),
        ...(item.look?.frames ?? []).flatMap((frame) => [
          ...Object.entries(frame.glyphs ?? {}),
          ...(frame.marks ?? []).flatMap((mark) => (mark.glyph === undefined ? [] : [["mark", mark.glyph] as const])),
        ]),
      ]
      for (const [part, glyph] of glyphs) {
        expect([...glyph].some(isWide), `${item.id} ${part}`).toBe(false)
        if (part !== "lv") expect([...glyph], `${item.id} ${part}`).toHaveLength(1)
      }
    }
  })

  it("loops only its epic and legendary band styles", () => {
    for (const item of starterCatalog.filter((one) => one.look !== null)) {
      const loops = item.look?.frames !== null
      expect(loops, item.id).toBe(item.rarity === "epic" || item.rarity === "legendary")
    }
  })
})

describe("the pet's wear", () => {
  /** The pet as the dressed canvas draws it with nothing on. */
  const plain = dressedPet([])
  const isPet = (x: number, y: number) => (plain.rows[y]?.[x] ?? emptyCell) !== emptyCell

  it("names its art by its sprite, and every piece of art is one the catalogue wears", () => {
    const worn = starterCatalog.filter((item) => item.slot !== null && petSlots.some((slot) => slot === item.slot))
    expect(worn.map((item) => item.id).sort()).toEqual(starterWear.map((item) => item.id).sort())
    for (const item of worn) expect(item.sprite, item.id).toBe(item.id)
    expect(Object.keys(starterWearArt).sort()).toEqual(worn.map((item) => item.id).sort())
  })

  it("draws each piece inside the canvas, in rows of one length, in its palette's colours, each of them used", () => {
    for (const [id, art] of Object.entries(starterWearArt)) {
      const width = art.rows[0]?.length ?? 0
      expect(art.rows.every((row) => row.length === width), id).toBe(true)
      expect(art.x >= 0 && art.y >= 0, id).toBe(true)
      expect(art.x + width <= dressedSize.width && art.y + art.rows.length <= dressedSize.height, id).toBe(true)
      const used = new Set([...art.rows.join("")].filter((cell) => cell !== emptyCell))
      expect([...used].filter((cell) => art.palette[cell] === undefined), id).toEqual([])
      expect(Object.keys(art.palette).filter((letter) => !used.has(letter)), id).toEqual([])
      for (const color of Object.values(art.palette)) expect(color, id).toMatch(/^#[0-9a-f]{6}$/u)
    }
  })

  it("shows every piece on the pet: one behind it shows round it, and no two pieces look the same", () => {
    const drawn = new Set<string>()
    for (const item of starterWear) {
      const slot = petSlots.find((one) => one === item.slot)
      const art = starterWearArt[item.id]
      if (slot === undefined || art === undefined) throw new Error(`${item.id} has no slot or art`)
      const dressed = dressedPet([{ slot, art }])
      const looks = dressed.rows.map((row) => [...row].map((cell) => dressed.palette[cell] ?? "").join(",")).join("/")
      expect(drawn.has(looks), item.id).toBe(false)
      drawn.add(looks)
      const changed = dressed.rows.flatMap((row, y) =>
        [...row].flatMap((cell, x) => {
          const before = plain.palette[plain.rows[y]?.[x] ?? emptyCell]
          return dressed.palette[cell] === before ? [] : [{ x, y }]
        })
      )
      expect(changed.length, item.id).toBeGreaterThan(wearBehind.includes(slot) ? 3 : 2)
      if (wearBehind.includes(slot)) {
        expect(changed.every(({ x, y }) => !isPet(x, y)), `${item.id} stays behind the pet`).toBe(true)
      }
    }
  })
})

describe("rules 15", () => {
  it("is rules 14 in every number, with catalogue 7 for catalogue 6", () => {
    expect({ ...starterRules, version: 14, catalogVersion: 6 }).toEqual(rules14)
    expect([starterRules.version, starterRules.catalogVersion]).toEqual([15, 7])
  })

  it("leaves catalogue 6 as rules 14 shipped it, field for field and in its order", () => {
    const shipped: unknown = JSON.parse(readFileSync(new URL("./fixtures/catalog-6.json", import.meta.url), "utf8"))
    expect(catalog6).toEqual(shipped)
  })

  const Roll = Schema.Struct({
    seed: Schema.String,
    number: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 })),
    chance: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
    pity: Pity,
    great: Schema.Boolean,
  })

  it.prop(
    "rolls the drop, rarity, gold and kind rules 14 did from the same draw: only which item differs",
    [Roll],
    ([roll]) => {
      const weights = (rules: typeof starterRules) =>
        roll.great ? { ...rules.loot.weights, rare: 202, epic: 80, legendary: 8 } : rules.loot.weights
      const { seed, number, chance, pity } = roll
      const now = rollLoot(seed, number, chance, starterRules, starterCatalog, pity, weights(starterRules))
      const then = rollLoot(seed, number, chance, rules14, catalog6, pity, weights(rules14))
      const kind = (drop: typeof now) =>
        drop === null ? null : { rarity: drop.rarity, gold: drop.gold, sigil: isSigil(drop.item) }
      expect(kind(now)).toEqual(kind(then))
    },
  )

  it("can drop every item of catalogue 7", () => {
    const pity = { sinceRare: 0, sinceEpic: 0 }
    for (const rarity of rarities) {
      const want = new Set(ofRarity(starterCatalog, rarity).map((item) => item.id))
      const seen = new Set<string>()
      for (let n = 0; n < 40_000 && seen.size < want.size; n++) {
        const drop = rollLoot("reach", n, 1, starterRules, starterCatalog, pity, starterRules.loot.weights, rarity)
        if (drop !== null) seen.add(drop.item.id)
      }
      expect([...want].filter((id) => !seen.has(id)), rarity).toEqual([])
    }
  })
})
