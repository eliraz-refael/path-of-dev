import type { PlayerState } from "@pathofdev/schema"
import { localDay } from "./days.ts"
import { noPrompts } from "./stats.ts"

/** A new player: level 0, no pet, nothing owned. */
export const initialState = (options: { characterName: string; timezone: string; now: string }): PlayerState => ({
  characterName: options.characterName,
  welcomedAt: null,
  timezone: options.timezone,
  progress: {
    xp: { verified: 0, reported: 0 },
    totals: {},
    missionsCompleted: 0,
    prestige: 0,
    prestigeXp: 0,
    tallies: [],
    activeDays: [],
    bestStreak: 0,
    quests: [],
    questWindows: { daily: null, weekly: null },
    presence: [],
    boosts: [],
    tests: { armed: [] },
    claims: [],
    stats: {
      clears: 0,
      compactions: { manual: 0, auto: 0 },
      commands: {},
      context: { crossed: { pct50: 0, pct75: 0, pct100: 0 }, sessions: 0, peakSum: 0, recent: [] },
      // Rubric 1's until the first rubric 2 prompt, which starts them afresh.
      prompts: noPrompts(1),
    },
  },
  holdings: {
    gold: 0,
    shards: { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0 },
    inventory: [],
    equipped: {},
    pet: null,
    egg: null,
    peakLevel: 0,
    achievements: [],
    completedQuests: [],
    loot: { nextRoll: 0, pity: { sinceRare: 0, sinceEpic: 0 } },
    shop: { day: localDay(options.now, options.timezone), bought: {} },
  },
})
