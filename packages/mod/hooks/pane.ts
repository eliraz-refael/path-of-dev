import type { PetSlot } from '@pathofdev/schema'
import type { BandLook, BandSlot, BandView, PaneTab, Tier, Wardrobe } from '../types'
import { tierRank } from './celebrate'
import { cellsOf } from './cells'
import { bandSlots, equippedIn, loops } from './looks'

// The `/pathofdev` pane: a hub of tabs, each a view of the game. This file says what the tabs are and what the
// inventory lists; register.tsx draws them. A later tab is one more entry here and one more body there.

/**
 * The pane's id, which `$.ui.open` and the `ui.render` matcher share: the engine keeps an open pane's record under its
 * id across a reload of the mod.
 */
export const paneId = 'pathofdev'

/** What `/questline`, the command's name from before Path of Dev, says the first time it runs. */
export const renamedNote = 'Questline is now Path of Dev: /questline is /pathofdev, and the old name goes away later.'

/**
 * The tabs in order, each with a shorter name for a narrow pane and a shortest for the narrowest; one not ready yet
 * shows dim, as what is coming. One with a `mark` (the welcome, which a player opens rarely) shrinks to it first when
 * it isn't the tab shown, and on the narrowest pane goes, still a command away.
 */
export const tabs: ReadonlyArray<{
  id: PaneTab
  label: string
  short: string
  tiny: string
  isReady: boolean
  mark?: string
}> = [
  { id: 'inventory', label: 'Inventory', short: 'Items', tiny: 'Inv', isReady: true },
  { id: 'shop', label: 'Shop', short: 'Shop', tiny: 'Shop', isReady: true },
  { id: 'stats', label: 'Stats', short: 'Stats', tiny: 'Stats', isReady: true },
  { id: 'missions', label: 'Missions', short: 'Missions', tiny: 'Quest', isReady: true },
  { id: 'welcome', label: 'Welcome', short: 'Welcome', tiny: 'Hi', isReady: true, mark: '?' },
]

/** The pane's title, which opens its header. */
export const brand = '✦ PATH OF DEV ✦'

/** Cells between the title and the character beside it. */
export const headerGap = 2

/**
 * The character beside the title, as much of it as `columns` leaves: the player's name goes first, then the level's
 * title, then the gold, so the header never wraps. Empty when not even the level fits.
 */
export const headerOf = (view: Pick<BandView, 'name' | 'level' | 'title' | 'gold'>, columns: number): string => {
  const room = columns - cellsOf(brand) - headerGap
  const { name, level, title, gold } = view
  const tries = [
    `${name} · Lv ${level} ${title} · ◈ ${gold}`,
    `Lv ${level} ${title} · ◈ ${gold}`,
    `Lv ${level} · ◈ ${gold}`,
    `Lv ${level}`,
  ]
  return tries.find((one) => cellsOf(one) <= room) ?? ''
}

/** One tab in the bar: the one shown, one to switch to, or one still to come (`soon` when there is room to say). */
export type TabChip = { id: PaneTab; text: string; kind: 'shown' | 'ready' | 'later'; soon: boolean }

/**
 * The tab bar as it fits `columns` on one row: first the gaps close up, then the `soon` labels go, then a tab with a
 * mark shrinks to it and then goes unless it is the one shown (it is a command away), then the names shorten and lose
 * their marks (the tab shown still stands out in the accent), shorten again, then the tabs still to come go.
 */
export const tabBarOf = (shown: PaneTab, columns: number): { gap: number; chips: Array<TabChip> } => {
  const chipsOf = (
    soon: boolean,
    withLater: boolean,
    size: 'full' | 'short' | 'bare' | 'tiny' = 'full',
    marked: 'named' | 'mark' | 'gone' = 'mark',
  ): Array<TabChip> =>
    tabs.flatMap((tab): Array<TabChip> => {
      const kind = tab.id === shown ? 'shown' : tab.isReady ? 'ready' : 'later'
      if (kind === 'later' && !withLater) return []
      if (tab.mark !== undefined && kind !== 'shown' && marked !== 'named') {
        return marked === 'gone' ? [] : [{ id: tab.id, text: tab.mark, kind, soon: false }]
      }
      const name = size === 'full' ? tab.label : size === 'tiny' ? tab.tiny : tab.short
      const text = size === 'bare' || size === 'tiny' ? name : `${kind === 'shown' ? '◆' : '◇'} ${name}`
      return [{ id: tab.id, text, kind, soon: soon && kind === 'later' }]
    })
  const widthOf = (bar: { gap: number; chips: ReadonlyArray<TabChip> }) =>
    bar.chips.reduce((sum, chip) => sum + cellsOf(chip.text) + (chip.soon ? ' soon'.length : 0), 0) +
    bar.gap * Math.max(0, bar.chips.length - 1)
  const tries = [
    { gap: 3, chips: chipsOf(true, true, 'full', 'named') },
    { gap: 2, chips: chipsOf(true, true, 'full', 'named') },
    { gap: 2, chips: chipsOf(false, true, 'full', 'named') },
    { gap: 1, chips: chipsOf(false, true, 'full', 'named') },
    { gap: 1, chips: chipsOf(false, true) },
    { gap: 1, chips: chipsOf(false, true, 'full', 'gone') },
    { gap: 1, chips: chipsOf(false, true, 'short', 'gone') },
    { gap: 1, chips: chipsOf(false, true, 'bare', 'gone') },
    { gap: 1, chips: chipsOf(false, true, 'tiny', 'gone') },
    { gap: 1, chips: chipsOf(false, false, 'tiny', 'gone') },
  ]
  return tries.find((bar) => widthOf(bar) <= columns) ?? { gap: 1, chips: chipsOf(false, false, 'tiny', 'gone') }
}

/** A tab the pane can show: the one asked for when it is ready, else the first that is. */
export const tabOf = (asked: PaneTab | null): PaneTab =>
  tabs.find((tab) => tab.id === asked && tab.isReady)?.id ?? 'inventory'

export const slotNames: Record<BandSlot, string> = {
  xpBar: 'XP bar',
  levelDisplay: 'Level',
  topEdge: 'Top edge',
  goldDisplay: 'Gold',
}


/** One look a band slot can wear: the mod's own (`entryId` null), or an owned band style. */
export type Choice = {
  /** Stable for the Buttons' keys: the item id, or `own`. */
  key: string
  name: string
  rarity: Tier | null
  /** The entry to equip: the one equipped, else the first owned. */
  entryId: string | null
  /** Copies owned. */
  count: number
  look: BandLook | null
  lore: string | null
  isWorn: boolean
  isLooping: boolean
  /** What the pane says in place of a rarity: the mod's own look, or an equipped item the snapshot can't name. */
  note: string | null
}

export type Section = { slot: BandSlot; title: string; choices: ReadonlyArray<Choice> }

/** The band slots in the band's order, each with the mod's own look first, then the owned ones, rarest first. */
export const lookSections = (wardrobe: Wardrobe | null): Array<Section> =>
  bandSlots.map((slot) => {
    const worn = equippedIn(wardrobe, slot)
    const owned = (wardrobe?.items ?? []).filter((item) => item.slot === slot && item.look !== null)
    const byItem = new Map<string, Choice>()
    for (const item of owned) {
      const seen = byItem.get(item.itemId)
      const isWorn = worn?.entryId === item.entryId
      byItem.set(item.itemId, {
        key: item.itemId,
        name: item.name,
        rarity: item.rarity,
        entryId: isWorn || seen === undefined ? item.entryId : seen.entryId,
        count: (seen?.count ?? 0) + 1,
        look: item.look,
        lore: item.lore,
        isWorn: isWorn || (seen?.isWorn ?? false),
        isLooping: loops(item.look),
        note: null,
      })
    }
    // An entry equipped there that the snapshot has no definition for (a later catalogue dropped it) still shows,
    // so it can be taken off.
    const entryId = wardrobe?.equipped[slot]
    const lost: Array<Choice> =
      entryId === undefined || worn !== null
        ? []
        : [
            {
              key: 'lost',
              name: 'Unknown style',
              rarity: null,
              entryId,
              count: 1,
              look: null,
              lore: null,
              isWorn: true,
              isLooping: false,
              note: 'no longer in the catalogue',
            },
          ]
    const styles = [...byItem.values()].sort(
      (a, b) => tierRank(b.rarity ?? 'common') - tierRank(a.rarity ?? 'common') || a.name.localeCompare(b.name),
    )
    const own: Choice = {
      key: 'own',
      name: 'Classic',
      rarity: null,
      entryId: null,
      count: 1,
      look: null,
      lore: null,
      isWorn: lost.length === 0 && !styles.some((choice) => choice.isWorn),
      isLooping: false,
      note: 'the band as it comes',
    }
    return { slot, title: slotNames[slot], choices: [own, ...lost, ...styles] }
  })

/** The pet's slots, in the order the pane lists its wear and the profile draws it. */
export const petSlots: ReadonlyArray<PetSlot> = ['head', 'neck', 'back', 'hand', 'aura']

/** One piece of the pet's wear owned: the entry to put on (the one worn, else the first owned) and how many. */
export type WearChoice = {
  /** Stable for the Buttons' keys: the item id, or `lost`. */
  key: string
  name: string
  rarity: Tier | null
  slot: PetSlot
  entryId: string
  count: number
  lore: string | null
  isWorn: boolean
  /** What the pane says in place of a rarity: for a worn entry the snapshot can't name. */
  note: string | null
}

/**
 * The pet's wear owned, slot by slot in the pet's order, rarest first within a slot, with what is worn marked. An
 * entry worn that the snapshot has no definition for still shows, first in its slot, so it can be taken off.
 */
export const wearChoices = (wardrobe: Wardrobe | null): Array<WearChoice> => {
  const byItem = new Map<string, WearChoice>()
  for (const item of wardrobe?.items ?? []) {
    const slot = petSlots.find((one) => one === item.slot)
    if (slot === undefined) continue
    const seen = byItem.get(item.itemId)
    const isWorn = wardrobe?.equipped[slot] === item.entryId
    byItem.set(item.itemId, {
      key: item.itemId,
      name: item.name,
      rarity: item.rarity,
      slot,
      entryId: isWorn || seen === undefined ? item.entryId : seen.entryId,
      count: (seen?.count ?? 0) + 1,
      lore: item.lore,
      isWorn: isWorn || (seen?.isWorn ?? false),
      note: null,
    })
  }
  const known = new Set((wardrobe?.items ?? []).map((item) => item.entryId))
  const lost = petSlots.flatMap((slot): Array<WearChoice> => {
    const entryId = wardrobe?.equipped[slot]
    if (entryId === undefined || known.has(entryId)) return []
    const note = 'no longer in the catalogue'
    return [
      { key: 'lost', name: 'Unknown wear', rarity: null, slot, entryId, count: 1, lore: null, isWorn: true, note },
    ]
  })
  const rank = (choice: WearChoice) => (choice.rarity === null ? 5 : tierRank(choice.rarity))
  return [...lost, ...byItem.values()].sort(
    (a, b) =>
      petSlots.indexOf(a.slot) - petSlots.indexOf(b.slot) || rank(b) - rank(a) || a.name.localeCompare(b.name),
  )
}

/** Everything else owned, by name, rarest first, with how many of each. */
export type OtherItem = { itemId: string; name: string; rarity: Tier; kind: string; count: number }

export const otherItems = (wardrobe: Wardrobe | null): Array<OtherItem> => {
  const counted = new Map<string, OtherItem>()
  for (const item of wardrobe?.items ?? []) {
    // Band styles and, from a server that deals in them, sigils have sections of their own, as food has the pet's card.
    if (item.look !== null || (item.sigil !== undefined && wardrobe?.knowsSigils === true)) continue
    if (item.food !== undefined && wardrobe?.knowsCare === true) continue
    // The pet's wear has a section of its own too.
    if (petSlots.some((slot) => slot === item.slot)) continue
    const seen = counted.get(item.itemId)
    const count = (seen?.count ?? 0) + 1
    const { itemId, name, rarity } = item
    counted.set(itemId, { itemId, name, rarity, kind: kindOf(item.category), count })
  }
  return [...counted.values()].sort((a, b) => tierRank(b.rarity) - tierRank(a.rarity) || a.name.localeCompare(b.name))
}

const kinds: Record<string, string> = {
  food: 'food',
  wearable: 'pet wear',
  scene: 'scene',
  title: 'title',
  artefact: 'artefact',
  levelUpEffect: 'level-up effect',
  sigil: 'sigil',
}

/** What an item is, in a word or two: a band style by the slot it fills, anything else by its kind. */
export const kindOf = (category: string, slot: string | null = null): string => {
  const band = bandSlots.find((one) => one === slot)
  if (category === 'bandStyle' && band !== undefined) return slotNames[band]
  return kinds[category] ?? category
}
