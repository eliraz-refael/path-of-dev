import type {
  AchievementDef,
  BandFrame,
  BandLook,
  BandSlot,
  Criterion,
  ItemDef,
  Metric,
  Rarity,
  RulesConfig,
  ScoringFact,
} from "@pathofdev/schema"
import { starterWear } from "./starter-wear.ts"

// The starter config and catalogue a fresh local server begins with: the design doc's numbers. One deviation for
// the proof of concept: merges are reported XP until the verifier lands, so the loop has its big moment.

const count = (of: Metric, atLeast: number): Criterion => ({ kind: "count", of, atLeast })
const fact = (fact: ScoringFact, atLeast: number): Criterion => count({ kind: "fact", fact }, atLeast)
const badge = (
  id: string,
  name: string,
  rarity: Rarity,
  glyph: string,
  about: string,
  criterion: Criterion,
): AchievementDef => ({ id, name, about, rarity, glyph, criterion })

/**
 * The starter badges, built on what the engine already counts. Their ids are kept for good: a renamed one would unlock
 * again. Reviews and prestige get theirs once something counts them.
 */
export const starterAchievements: ReadonlyArray<AchievementDef> = [
  badge("first-commit", "First commit", "common", "📝", "Make your first commit.", fact("commit.made", 1)),
  badge("first-merge", "First merge", "common", "🔀", "Get a change merged.", fact("change.merged", 1)),
  badge("hatched", "Hatchling", "common", "🥚", "Hatch your pet.", count({ kind: "hatched" }, 1)),
  badge(
    "first-mission",
    "Mission accomplished",
    "common",
    "🎯",
    "Complete a mission.",
    count({ kind: "missions" }, 1),
  ),
  badge("commits-100", "Committed", "uncommon", "💯", "Make 100 commits.", fact("commit.made", 100)),
  badge("merges-50", "Merge train", "rare", "🚂", "Get 50 changes merged.", fact("change.merged", 50)),
  badge("prompts-500", "Wordsmith", "rare", "🪶", "Have 500 prompts graded.", fact("prompt.graded", 500)),
  badge("streak-7", "A week strong", "uncommon", "🔥", "Keep a streak for 7 days.", count({ kind: "streak" }, 7)),
  badge("streak-30", "Habit formed", "epic", "📅", "Keep a streak for 30 days.", count({ kind: "streak" }, 30)),
  badge("streak-100", "Unbroken", "legendary", "♾️", "Keep a streak for 100 days.", count({ kind: "streak" }, 100)),
  badge(
    "perfect-prompt",
    "Perfect prompt",
    "rare",
    "💎",
    "Write a prompt graded 10.",
    count({ kind: "bestGrade" }, 10),
  ),
  badge(
    "sharp-prompter",
    "Sharp prompter",
    "epic",
    "🧠",
    "Keep an average grade of 8 or more over at least 100 graded prompts.",
    { kind: "average", of: "promptGrade", atLeast: 8, over: 100 },
  ),
  badge(
    "light-context",
    "Light touch",
    "rare",
    "🍃",
    "Keep a lifetime average context peak under 50% over at least 30 sessions.",
    { kind: "average", of: "contextPeak", below: 50, over: 30 },
  ),
  badge(
    "calm-25",
    "Never past 75",
    "rare",
    "🧘",
    "Finish 25 sessions whose context never reached 75%.",
    count({ kind: "calmSessions", under: "pct75" }, 25),
  ),
  badge("level-10", "Level 10", "common", "🌱", "Reach level 10.", count({ kind: "level" }, 10)),
  badge("level-25", "Level 25", "rare", "🌳", "Reach level 25.", count({ kind: "level" }, 25)),
  badge("level-50", "Level 50", "legendary", "🏔️", "Reach level 50.", count({ kind: "level" }, 50)),
  badge(
    "legendary-find",
    "Legendary find",
    "epic",
    "🏆",
    "Own a legendary item.",
    count({ kind: "owned", rarity: "legendary" }, 1),
  ),
  badge(
    "full-band",
    "Full band",
    "epic",
    "🎨",
    "Own a band style for each of the band's four slots.",
    count({ kind: "bandSlots", slots: ["xpBar", "levelDisplay", "topEdge", "goldDisplay"] }, 4),
  ),
]

export const starterRules: RulesConfig = {
  version: 15,
  schemaVersion: 11,
  appliesFrom: null,
  // Steeper than the 1.6 before sigils: a player wearing the sigil typical of their stage reaches each level about
  // when one without sigils did, on the doc's steady day of 400 XP of work and 200 of prompts. Level 1 stays 100 XP.
  levelCurve: { base: 100, exponent: 1.66 },
  titles: [
    { fromLevel: 1, title: "Apprentice" },
    { fromLevel: 10, title: "Adept" },
    { fromLevel: 25, title: "Artisan" },
    { fromLevel: 50, title: "Master" },
    { fromLevel: 75, title: "Grandmaster" },
    { fromLevel: 100, title: "Legend" },
  ],
  // The emoji carry their selector, so every terminal draws them two cells wide; the mod pads ⚔ to the same two.
  glyphs: [
    { fromLevel: 0, glyph: "⚔" },
    { fromLevel: 5, glyph: "🗡️" },
    { fromLevel: 10, glyph: "🛡️" },
    { fromLevel: 15, glyph: "👑" },
    { fromLevel: 20, glyph: "🐉" },
  ],
  xp: {
    // 120 in a repo the change's author owns, 250 elsewhere; a change of 1 or 2 lines pays a quarter of either.
    "change.merged": { xp: 250, tier: "reported", dailyCap: null, ownRepoXp: 120, tinyDiffPct: 25, tinyDiffLines: 3 },
    "change.opened": { xp: 0, tier: "reported", dailyCap: null },
    "commit.made": { xp: 3, tier: "reported", dailyCap: 20 },
    "review.acted_on": { xp: 80, tier: "verified", dailyCap: 10 },
    "issue.closed": { xp: 60, tier: "verified", dailyCap: 5 },
    "bug.fixed": { xp: 150, tier: "verified", dailyCap: 5 },
    "first.contribution": { xp: 300, tier: "verified", dailyCap: null },
    "tests.green": { xp: 20, tier: "reported", dailyCap: 5 },
    "repo.explored": { xp: 25, tier: "reported", dailyCap: 3 },
    "streak.day": { xp: 10, tier: "reported", dailyCap: 1 },
  },
  loot: {
    chancePerTurn: 0.12,
    // 12% at an average grade of 5, the turn's chance; 24% at 10. A grade of 9 or more doubles rare and better. Rubric
    // 1's, and frozen: rubric 2's are `prompt.v2.loot`.
    promptChanceAtTen: 0.24,
    promptGreatAt: 9,
    promptGreatRareFactor: 2,
    chanceOnVerified: 1,
    // In thousandths, so legendary can be 0.4%: on about five drops a day, one legendary every 50 days or so. The 6
    // thousandths it gave up went to the rarities below it in proportion to their odds, rounded so each table sums to
    // 1000. The level-up table split its 6 the same way.
    weights: { common: 604, uncommon: 251, rare: 101, epic: 40, legendary: 4 },
    // Of each rarity's drops, the share that is a sigil. On about five drops a day the typical player wears a common
    // by day 3, an uncommon by the first week, a rare by the first month and an epic by the third; at 0.4% legendary,
    // about a third find a legendary sigil in the first year. Legendaries are so rare a find that their sigils take a
    // bigger share of them.
    sigilShare: { common: 0.08, uncommon: 0.04, rare: 0.03, epic: 0.03, legendary: 0.06 },
    onLevelUp: { weights: { common: 503, uncommon: 302, rare: 151, epic: 40, legendary: 4 } },
    pity: { rareAfter: 25, epicAfter: 80 },
    gold: { common: 10, uncommon: 25, rare: 70, epic: 175, legendary: 400 },
    shardsToCraft: 10,
    salvageShards: { common: 1, uncommon: 1, rare: 1, epic: 1, legendary: 1 },
    rerollGold: { common: 20, uncommon: 50, rare: 120, epic: 300, legendary: 800 },
  },
  pet: {
    moodDecayPerDay: 10,
    happyAbove: 70,
    happyXpBonusPct: 5,
    evolveAt: [10, 25, 50],
    // A meal lifts the mood by three days' drift and a pat by half a day's, three pats an hour at most: a meal every
    // few days, or a few pats, keeps a pet happy.
    care: { fed: 30, petted: 5, pettedPerHour: 3 },
    // The design doc's four starter eggs, in the order the welcome offers them. A player who never picks one hatches
    // the fox Ember, as every egg did before the welcome.
    species: [
      { id: "fox", name: "Fox", about: "quick, curious" },
      { id: "slime", name: "Slime", about: "soft, cheerful" },
      { id: "robot", name: "Robot", about: "steady, precise" },
      { id: "owl", name: "Owl", about: "calm, wise" },
    ],
    egg: { species: "fox", name: "Ember" },
  },
  // Four band styles a day, common and uncommon, one of each, and the treats every day, three of each. A steady day
  // earns about 240 gold (about 140 from five drops, the rest from missions), so a common style costs half a day's
  // gold, an uncommon one a day's, and a treat a few percent. Treats lift the mood only: XP food is never sold. Pet
  // wear, scenes and level-up effects join the shelf once the band draws them.
  shop: {
    offers: 4,
    rarities: ["common", "uncommon"],
    categories: ["bandStyle"],
    stock: 1,
    prices: { common: 120, uncommon: 250, rare: 600, epic: 1500, legendary: 4000 },
    food: { stock: 3, prices: { common: 15, uncommon: 35, rare: 80, epic: 200, legendary: 500 } },
  },
  streak: { xpPerDay: 10, maxXp: 70, restDaysPerWeek: 1 },
  prompt: {
    rubricVersion: 2,
    // Rubric 1's, frozen from rules 13 on so its prompts in the log replay as they were priced: the weights, maxXp,
    // regretAt and the loot's promptChanceAtTen and promptGreatAt. Tuning goes to `v2`.
    // Equal weights: the plain average of the quality scores, so a perfect grade earns maxXp.
    weights: { clarity: 1, grammar: 1, specificity: 1, instructive: 1, context: 1, doneCriteria: 1, focus: 1 },
    maxXp: 20,
    perDay: [
      { upTo: 20, pct: 100 },
      { upTo: 40, pct: 50 },
      { upTo: null, pct: 10 },
    ],
    // Haiku scores a regret of 1 or 2 on many a prompt that walks nothing back.
    regretAt: 5,
    // Never overlapping, and a tenth apart, so on a prompt worth 10 XP or more every rarity earns more than the one
    // below it, after rounding down: epic's top ×2.2 earns 22 on 10 XP, legendary's bottom ×2.3 earns 23.
    sigilMultiplier: {
      common: [1.2, 1.3],
      uncommon: [1.4, 1.6],
      rare: [1.7, 1.9],
      epic: [2, 2.2],
      legendary: [2.3, 2.5],
    },
    // Rubric 2 grades a prompt against what it needs, so real prompts grade higher than under rubric 1: a mean of 7.31
    // where rubric 1 gave 5.35, in the grading experiment. maxXp 15 and a loot chance of 0.175 at 10 keep a typical
    // prompt's XP and drops about where rubric 1 has them (20 * 5.35 / 7.31 = 14.6, 0.24 * 5.35 / 7.31 = 0.1756). A
    // 9 still doubles rare and better: only prompts with substance reach it, as a steer is capped at 8.
    v2: {
      maxXp: 15,
      // What the experiment's prompts most needed weighs most: knowing what is wanted, and moving the work forward.
      weights: { intent: 1.5, grounding: 1, why: 1, successShape: 1, scope: 1, forward: 1.5 },
      // Up to half a point for writing above plain (6), all of it at 10.
      craft: { from: 6, span: 4, max: 0.5 },
      // Up to 0.4 for a prompt spelled clean, all of it from 60 words on, so a short one gains little.
      spelling: { fullAtWords: 60, max: 0.4 },
      // Kindness lifts a little, 0.3 at most; a rough tone costs more, 1.8 at a tone of 1.
      tone: { upFrom: 6, upPer: 0.075, downFrom: 4, downPer: 0.6 },
      // A hostile prompt grades 3.5 at most, and a steer 8: a 9 takes substance.
      caps: { hostile: { toneAtMost: 2, grade: 3.5 }, steer: { grade: 8 } },
      loot: { chanceAtTen: 0.175, greatAt: 9 },
    },
  },
  catalogVersion: 7,
  // Three dailies run each local day; each local week offers five weeklies, of which three can run at once.
  missions: {
    daily: { count: 3, tier: "uncommon" },
    weekly: { offered: 5, active: 3, tier: "rare" },
  },
  questPacks: ["starter"],
  achievements: starterAchievements,
}

const item = (def: Pick<ItemDef, "id" | "name" | "rarity" | "category" | "slot"> & Partial<ItemDef>): ItemDef => ({
  sprite: null,
  lore: null,
  effect: null,
  look: null,
  ...def,
})

/** A band style: a look for one band slot, still unless it has frames. */
const style = (
  id: string,
  name: string,
  rarity: Rarity,
  slot: BandSlot,
  look: Pick<BandLook, "glyphs" | "colors"> & Partial<BandLook>,
  lore: string | null = null,
): ItemDef => item({ id, name, rarity, category: "bandStyle", slot, lore, look: { frames: null, fps: null, ...look } })

const white = "#ffffff"

/** A head that twinkles through `glyphs` and `colors`, one frame each, for a bar whose sheen does the travelling. */
const headTwinkle = (glyphs: ReadonlyArray<string>, colors: ReadonlyArray<string>): Array<BandFrame> =>
  glyphs.map((glyph, i) => ({ glyphs: { head: glyph }, colors: { head: pick(colors, i) } }))

/**
 * Twinkles at fixed places along the track, each running `glyphs` out of step with its neighbours, in the color at the
 * same step of `colors`, so a star brightens and dims with its glyph.
 */
const twinkle = (
  places: ReadonlyArray<number>,
  glyphs: ReadonlyArray<string>,
  colors: ReadonlyArray<string>,
  accent: (i: number) => Omit<BandFrame, "marks"> = () => ({}),
): Array<BandFrame> =>
  Array.from({ length: glyphs.length }, (_, i) => ({
    ...accent(i),
    marks: places.flatMap((at, j) => {
      const phase = (i + j * 3) % glyphs.length
      const glyph = glyphs[phase]
      const color = colors[phase % colors.length] ?? white
      return glyph === undefined || glyph === " " ? [] : [{ at, glyph, color }]
    }),
  }))

/** One value per frame from a short cycle. */
const pick = (values: ReadonlyArray<string>, i: number): string => values[i % values.length] ?? white

// The band styles, a few per rarity. Common to rare are still: other glyphs and color themes. Epic and legendary
// loop: a sheen along the XP bar, stars along the edge, a glint on the gold.
const bandStyles: ReadonlyArray<ItemDef> = [
  style("solid-bar", "Solid Bar", "common", "xpBar", {
    glyphs: { full: "█", empty: "░" },
    colors: { full: "#87d787", empty: "#4e4e4e" },
  }),
  style("double-rule", "Double Rule", "common", "topEdge", {
    glyphs: { line: "═", left: "╡", right: "╞", knot: "◇", dot: "═" },
    colors: {
      line: "#808080",
      left: "#a8a8a8",
      right: "#a8a8a8",
      star: "#d0d0d0",
      title: "#e4e4e4",
      knot: "#a8a8a8",
      dot: "#808080",
    },
  }),
  style("copper-purse", "Copper Purse", "common", "goldDisplay", {
    glyphs: { icon: "●" },
    colors: { icon: "#d7875f", amount: "#d7af87" },
  }),
  style("bead-string", "Bead String", "uncommon", "xpBar", {
    glyphs: { full: "●", empty: "○" },
    colors: { full: "#5fd7ff", empty: "#585858", label: "#87d7ff" },
  }),
  style("squires-plate", "Squire's Plate", "uncommon", "levelDisplay", {
    glyphs: { left: "⟦", right: "⟧" },
    colors: { level: "#5fd75f", left: "#87af87", right: "#87af87", title: "#afd7af" },
  }),
  style("meadow-rule", "Meadow Rule", "uncommon", "topEdge", {
    glyphs: { line: "╌", knot: "✧", dot: "╌" },
    colors: {
      line: "#5f875f",
      left: "#5f875f",
      right: "#5f875f",
      star: "#87d787",
      title: "#d7ffaf",
      knot: "#87d787",
      dot: "#5f875f",
    },
  }),
  style("tempered-steel", "Tempered Steel", "rare", "xpBar", {
    glyphs: { full: "━", empty: "╍", head: "╸" },
    colors: { full: "#4ea8ff", empty: "#303a4e", head: "#b8dcff", label: "#87afff" },
  }),
  style("sapphire-purse", "Sapphire Purse", "rare", "goldDisplay", {
    glyphs: { icon: "◆", spark: "✧" },
    colors: { icon: "#4ea8ff", amount: "#b8dcff", spark: "#87afff" },
  }),
  style("runic-crest", "Runic Crest", "rare", "levelDisplay", {
    glyphs: { lv: "ʟᴠ", left: "❮", right: "❯" },
    colors: { glyph: "#b8dcff", level: "#4ea8ff", title: "#87afff", left: "#5f87d7", right: "#5f87d7" },
  }),
  style(
    "arcane-current",
    "Arcane Current",
    "epic",
    "xpBar",
    {
      glyphs: { full: "▰", empty: "▱", head: "✦" },
      colors: { full: "#9d4edd", empty: "#3c2a4d", head: "#e0aaff", label: "#c77dff" },
      // A soft violet light runs along the filled bar and rests a second, the head twinkling throughout.
      frames: headTwinkle(["✦", "✧", "⋆", "✧"], ["#e0aaff", white, "#c77dff", white]),
      fps: 6,
      sheen: { colors: ["#7b2cbf", "#c77dff", "#e0aaff", white], rest: 6 },
    },
    "It hums when the tests go green.",
  ),
  style(
    "starlit-edge",
    "Starlit Edge",
    "epic",
    "topEdge",
    {
      glyphs: { star: "✦", knot: "✧" },
      colors: {
        line: "#5a4a78",
        left: "#7b6cf6",
        right: "#7b6cf6",
        star: "#c77dff",
        title: "#e0aaff",
        knot: "#9d8cff",
        dot: "#5a4a78",
      },
      // Stars come and go along the edge, out of step, while the two by the name trade places.
      frames: twinkle(
        [0.06, 0.19, 0.33, 0.47, 0.6, 0.74, 0.88],
        ["·", "⋆", "✧", "✦", "✧", "⋆", " ", " "],
        ["#7b6cf6", "#9d8cff", "#e0aaff", white, "#e0aaff", "#9d8cff"],
        (i) => ({ glyphs: { star: pick(["✦", "✧"], Math.floor(i / 2)) } }),
      ),
      fps: 5,
    },
    "Cut from the night the first merge landed.",
  ),
  style(
    "starforged-bar",
    "Starforged Bar",
    "legendary",
    "xpBar",
    {
      glyphs: { full: "▰", empty: "▱", head: "✸" },
      colors: { full: "#ffb627", empty: "#4d3a12", head: "#fff1a8", label: "#ffd23f" },
      // Molten light runs along the filled bar, the head flaring like a forge.
      frames: headTwinkle(["✸", "✦", "✧", "✦"], ["#fff1a8", white, "#ffd23f", white]),
      fps: 6,
      sheen: { colors: ["#ff9f1c", "#ffd23f", "#fff1a8", white], rest: 4 },
    },
    "Hammered from a fallen star.",
  ),
  style(
    "dragons-hoard",
    "Dragon's Hoard",
    "legendary",
    "goldDisplay",
    {
      glyphs: { icon: "◈", spark: "✧" },
      colors: { icon: "#ffb627", amount: "#ffd23f", spark: "#fff1a8" },
      // The coin catches the light, and a spark winks beside the count.
      frames: Array.from({ length: 8 }, (_, i) => ({
        glyphs: {
          icon: pick(["◈",
          "◈",
          "◆",
          "◈",
          "◈",
          "◇",
          "◈",
          "◈"],
          i),
          spark: pick(["✧",
          "✦",
          "⋆",
          "·",
          "˚",
          "·",
          "⋆",
          "✦"],
          i),
        },
        colors: {
          icon: pick(["#ffb627", "#ffd23f", white, "#ffd23f", "#ffb627", "#ff9f1c", "#ffb627", "#ffd23f"], i),
          spark: pick(["#fff1a8", white, "#ffd23f", "#ff9f1c", "#ffd23f", "#fff1a8", white, "#fff1a8"], i),
        },
      })),
      fps: 4,
    },
    "Every coin remembers the quest that paid it.",
  ),
  style(
    "crown-of-ages",
    "Crown of Ages",
    "legendary",
    "levelDisplay",
    {
      glyphs: { left: "✧", right: "✧" },
      colors: { glyph: "#ffd23f", level: "#ffb627", title: "#ffe8a3", left: "#ffd23f", right: "#ffd23f" },
      // Stars either side of the level twinkle in turn.
      frames: Array.from({ length: 6 }, (_, i) => ({
        glyphs: {
          left: pick(["✧", "✦", "⋆", "✦", "✧", "·"], i),
          right: pick(["✦", "✧", "·", "✧", "✦", "⋆"], i),
        },
        colors: { left: pick([white, "#ffd23f", "#ffb627"], i), right: pick(["#ffb627", white, "#ffd23f"], i) },
      })),
      fps: 4,
    },
    "Worn by those who never break the streak.",
  ),
]

/** A rainbow, one colour a frame, for a look whose accents cycle through it. */
const rainbow = ["#ff5f5f", "#ffaf5f", "#ffd75f", "#87d75f", "#5fafff", "#af87ff"]

// The band styles of catalogue 7, the same rule by rarity: common to rare still, epic and legendary loop.
const moreBandStyles: ReadonlyArray<ItemDef> = [
  style(
    "dotted-line",
    "Dotted Line",
    "common",
    "xpBar",
    { glyphs: { full: "•", empty: "·" }, colors: { full: "#d0d0d0", empty: "#585858" } },
    "Sign here, then keep going.",
  ),
  style(
    "hash-bar",
    "Hash Bar",
    "common",
    "xpBar",
    {
      glyphs: { full: "#", empty: "-", left: "[", right: "]" },
      colors: { full: "#87af87", empty: "#4e4e4e", left: "#808080", right: "#808080" },
    },
    "Progress, the way an old installer drew it.",
  ),
  style(
    "brick-bar",
    "Brick Bar",
    "common",
    "xpBar",
    { glyphs: { full: "▓", empty: "░" }, colors: { full: "#d7875f", empty: "#4e3a30", label: "#d7af87" } },
    "Laid one commit at a time.",
  ),
  style(
    "bracket-badge",
    "Bracket Badge",
    "common",
    "levelDisplay",
    {
      glyphs: { left: "[", right: "]" },
      colors: { level: "#d0d0d0", left: "#808080", right: "#808080", title: "#a8a8a8" },
    },
    "Square brackets, for a level that means business.",
  ),
  style(
    "paren-badge",
    "Paren Badge",
    "common",
    "levelDisplay",
    {
      glyphs: { left: "(", right: ")" },
      colors: { level: "#d7af87", left: "#af875f", right: "#af875f", title: "#d7c3a8" },
    },
    "Optional, but you wore it anyway.",
  ),
  style(
    "angle-badge",
    "Angle Badge",
    "common",
    "levelDisplay",
    {
      glyphs: { left: "<", right: ">" },
      colors: { level: "#87afd7", left: "#5f87af", right: "#5f87af", title: "#afc8e4" },
    },
    "Opened like a tag, and properly closed.",
  ),
  style(
    "dashed-rule",
    "Dashed Rule",
    "common",
    "topEdge",
    {
      glyphs: { line: "┄", left: "┤", right: "├", knot: "·", dot: "┄" },
      colors: {
        line: "#6c6c6c",
        left: "#8a8a8a",
        right: "#8a8a8a",
        star: "#bcbcbc",
        title: "#d0d0d0",
        knot: "#8a8a8a",
        dot: "#6c6c6c",
      },
    },
    "Cut along the dotted line, carefully.",
  ),
  style(
    "rope-rule",
    "Rope Rule",
    "common",
    "topEdge",
    {
      glyphs: { line: "~", left: "{", right: "}", knot: "∘", dot: "~" },
      colors: {
        line: "#af875f",
        left: "#d7af87",
        right: "#d7af87",
        star: "#d7af87",
        title: "#e4d0b8",
        knot: "#d7af87",
        dot: "#af875f",
      },
    },
    "Knotted every so often, to hold the band up.",
  ),
  style(
    "brass-button",
    "Brass Button",
    "common",
    "goldDisplay",
    { glyphs: { icon: "◉" }, colors: { icon: "#c9a227", amount: "#e4c86a" } },
    "Off an old coat, and worth more than it looks.",
  ),
  style(
    "tin-purse",
    "Tin Purse",
    "common",
    "goldDisplay",
    { glyphs: { icon: "○" }, colors: { icon: "#a8a8a8", amount: "#c6c6c6" } },
    "Rattles more than it holds.",
  ),
  style(
    "circuit-trace",
    "Circuit Trace",
    "uncommon",
    "xpBar",
    { glyphs: { full: "━", empty: "┄" }, colors: { full: "#5fd787", empty: "#2f4f3f", label: "#87d7af" } },
    "Etched one connection at a time.",
  ),
  style(
    "scroll-tag",
    "Scroll Tag",
    "uncommon",
    "levelDisplay",
    {
      glyphs: { left: "⟨", right: "⟩" },
      colors: { glyph: "#e4d8b8", level: "#d7af5f", left: "#af875f", right: "#af875f", title: "#e4d8b8" },
    },
    "Unrolled anew for every level.",
  ),
  style(
    "brook-rule",
    "Brook Rule",
    "uncommon",
    "topEdge",
    {
      glyphs: { line: "≈", left: "╡", right: "╞", knot: "◦", dot: "≈" },
      colors: {
        line: "#5f87af",
        left: "#5f87af",
        right: "#5f87af",
        star: "#87d7ff",
        title: "#d7f4ff",
        knot: "#87d7ff",
        dot: "#5f87af",
      },
    },
    "Babbles along, like a log at debug level.",
  ),
  style(
    "silver-purse",
    "Silver Purse",
    "uncommon",
    "goldDisplay",
    { glyphs: { icon: "◇" }, colors: { icon: "#d0d0d0", amount: "#e4e4e4" } },
    "Polished each time a bug is fixed.",
  ),
  style(
    "jade-purse",
    "Jade Purse",
    "uncommon",
    "goldDisplay",
    { glyphs: { icon: "◆" }, colors: { icon: "#3faf7f", amount: "#87d7af" } },
    "Carved from a stone that sat by a quiet server.",
  ),
  style(
    "frost-rule",
    "Frost Rule",
    "rare",
    "topEdge",
    {
      glyphs: { line: "─", left: "┤", right: "├", star: "✻", knot: "✻", dot: "·" },
      colors: {
        line: "#5f87af",
        left: "#87afd7",
        right: "#87afd7",
        star: "#d7f4ff",
        title: "#ffffff",
        knot: "#afd7ff",
        dot: "#5f87af",
      },
    },
    "Clear and cold, like a well-written error.",
  ),
  style(
    "kiln-bar",
    "Kiln Bar",
    "rare",
    "xpBar",
    {
      glyphs: { full: "▮", empty: "▯", head: "▸" },
      colors: { full: "#ff875f", empty: "#4e2a1f", head: "#ffd7af", label: "#ffaf87" },
    },
    "Fired hot, cooled slowly, and never cracked.",
  ),
  style(
    "prism-plate",
    "Prism Plate",
    "epic",
    "levelDisplay",
    {
      glyphs: { left: "⟪", right: "⟫" },
      colors: { glyph: "#ffffff", level: "#ffffff", title: "#e0aaff", left: "#ff5f5f", right: "#5fafff" },
      // The brackets and the glyph run through the rainbow, out of step.
      frames: rainbow.map((_, i) => ({
        colors: { left: pick(rainbow, i), right: pick(rainbow, i + 3), glyph: pick(rainbow, i + 1) },
      })),
      fps: 3,
    },
    "Splits one level into every colour.",
  ),
  style(
    "comet-purse",
    "Comet Purse",
    "epic",
    "goldDisplay",
    {
      glyphs: { icon: "◈", spark: "✦" },
      colors: { icon: "#c77dff", amount: "#e0aaff", spark: "#ffffff" },
      // A spark streaks past the count and fades, the coin glowing as it goes.
      frames: Array.from({ length: 6 }, (_, i) => ({
        glyphs: { spark: pick(["✦", "✧", "⋆", "·", " ", "·"], i) },
        colors: {
          icon: pick(["#c77dff", "#e0aaff", white, "#e0aaff", "#c77dff", "#9d4edd"], i),
          spark: pick([white, "#e0aaff", "#c77dff", "#9d4edd", "#9d4edd", "#c77dff"], i),
        },
      })),
      fps: 4,
    },
    "Every coin leaves a little tail.",
  ),
  style(
    "aurora-edge",
    "Aurora Edge",
    "legendary",
    "topEdge",
    {
      glyphs: { star: "✦", knot: "✧" },
      colors: {
        line: "#1f4f4f",
        left: "#3fd7af",
        right: "#c77dff",
        star: "#3fd7af",
        title: "#d7fff4",
        knot: "#5fafff",
        dot: "#1f4f4f",
      },
      // Green, teal and violet light sweeps the edge, a few stars winking as it passes.
      frames: twinkle(
        [0.12, 0.38, 0.62, 0.88],
        ["·", "✧", "✦", "✧", " ", " "],
        ["#3fd7af", "#5fafff", "#c77dff", "#5fafff"],
        (i) => ({ colors: { star: pick(["#3fd7af", "#5fafff", "#c77dff"], Math.floor(i / 2)) } }),
      ),
      fps: 5,
      sheen: { colors: ["#1f6f5f", "#3fd7af", "#5fafff", "#c77dff"], rest: 8 },
    },
    "The northern lights, folded over the band.",
  ),
]

/** A sigil: its multiplier on prompt XP, inside its rarity's range, and the mark the pane draws it with. */
const sigil = (
  id: string,
  name: string,
  rarity: Rarity,
  multiplier: number,
  glyph: string,
  color: string,
  lore: string,
): ItemDef => item({ id, name, rarity, category: "sigil", slot: "sigil", lore, sigil: { multiplier, glyph, color } })

// The sigils of catalogue 6, two a rarity, one low in its range and one high: a mark that grows from an outlined star
// to a sun.
const sigils: ReadonlyArray<ItemDef> = [
  sigil("chalk-sigil", "Chalk Sigil", "common", 1.2, "✧", "#bcbcbc", "Drawn in a hurry on the back of a ticket."),
  sigil("ember-sigil", "Ember Sigil", "common", 1.3, "✧", "#d7875f", "Still warm from the first green build."),
  sigil("fern-sigil", "Fern Sigil", "uncommon", 1.4, "✦", "#5fd75f", "Unfurls a little with every clear ask."),
  sigil("tide-sigil", "Tide Sigil", "uncommon", 1.6, "✦", "#5fd7d7", "Comes back stronger, like a prompt reworded."),
  sigil("lantern-sigil", "Lantern Sigil", "rare", 1.7, "✶", "#4ea8ff", "Lights the next step, and only the next."),
  sigil("frost-sigil", "Frost Sigil", "rare", 1.9, "✶", "#b8dcff", "Cold, precise, never vague."),
  sigil("arcane-sigil", "Arcane Sigil", "epic", 2, "✹", "#c77dff", "Hums when the done criteria are spelled out."),
  sigil("storm-sigil", "Storm Sigil", "epic", 2.2, "✹", "#9d4edd", "Crackles at a well-scoped ask."),
  sigil("dawn-sigil", "Dawn Sigil", "legendary", 2.3, "❂", "#ffd23f", "Rises over every plan made before the code."),
  sigil("wyrm-sigil", "Wyrm Sigil", "legendary", 2.5, "✺", "#ff9f1c", "Cut from a dragon that read every spec."),
]

// Catalogue 7's sigils, each in the middle of its rarity's range or a pair either side of it, so every rarity's sigils
// still average what its two did: a bigger pool never makes a typical sigil stronger.
const moreSigils: ReadonlyArray<ItemDef> = [
  sigil("ink-sigil", "Ink Sigil", "common", 1.25, "✧", "#8a9bd8", "Blotted on a sticky note, and still legible."),
  sigil("pebble-sigil", "Pebble Sigil", "common", 1.25, "✧", "#a89878", "Worn smooth by a thousand clear asks."),
  sigil("moss-sigil", "Moss Sigil", "uncommon", 1.5, "✦", "#87af5f", "Grows quietly on the code that just works."),
  sigil("kite-sigil", "Kite Sigil", "uncommon", 1.5, "✦", "#ff875f", "Flies best with a clear line to hold."),
  sigil("compass-sigil", "Compass Sigil", "rare", 1.8, "✶", "#5fafd7", "Points at what the prompt left unsaid."),
  sigil("nebula-sigil", "Nebula Sigil", "epic", 2.1, "✹", "#af87ff", "Swirls until the requirements settle."),
  sigil("zenith-sigil", "Zenith Sigil", "legendary", 2.4, "❂", "#fff1a8", "Shines straight down on finished work."),
]

/** Food: a treat lifts the pet's mood and nothing else, and XP food also starts an XP boost. */
const food = (
  id: string,
  name: string,
  rarity: Rarity,
  lore: string,
  effect: ItemDef["effect"] = null,
): ItemDef => item({ id, name, rarity, category: "food", slot: null, lore, effect })

/** XP food's boost at each rarity it drops at: 10% for an hour, two at uncommon, three at rare. */
const boost = { common: { xpBoostPct: 10, minutes: 60 }, uncommon: { xpBoostPct: 10, minutes: 120 } } as const
const rareBoost = { xpBoostPct: 10, minutes: 180 }

// Treats lift the pet's mood and nothing else: the shop sells them. XP food also starts an XP boost, so it comes only
// from play, as drops and mission rewards. Catalogue 7 keeps XP food the share of its rarity's drops it was (a
// seventh of common, an eighth of uncommon, a sixth of rare), so a bigger pool boosts XP no more and no less often.
const foods: ReadonlyArray<ItemDef> = [
  food("honey-biscuit", "Honey Biscuit", "common", "Baked in the shape of a tiny paw."),
  food("jam-drop", "Jam Drop", "common", "A thumbprint of jam, pressed in with care."),
  food("apple-slices", "Apple Slices", "common", "Crisp, cold, and cut into exactly eight."),
  food("sugar-plum", "Sugar Plum", "uncommon", "Saved for a pet that sat through a long build."),
  food("cinnamon-roll", "Cinnamon Roll", "uncommon", "Unrolls slowly, like a good explanation."),
  food("trail-mix", "Trail Mix", "common", "Nuts, seeds and the odd chocolate chip.", boost.common),
  food("cold-brew", "Cold Brew", "common", "Steeped overnight, like a long-running test.", boost.common),
  food("rice-ball", "Rice Ball", "common", "Packed for a long session, gone before the first build.", boost.common),
  food("granola-bar", "Granola Bar", "common", "Mostly oats, partly optimism.", boost.common),
  food("fortune-cookie", "Fortune Cookie", "common", "It says: your next commit will be a small one.", boost.common),
  food("berry-tart", "Berry Tart", "uncommon", "Still warm, and gone in two bites.", boost.uncommon),
  food("miso-soup", "Miso Soup", "uncommon", "Warm enough for one more refactor.", boost.uncommon),
  food("pocket-pie", "Pocket Pie", "uncommon", "Folded shut, like a well-kept function.", boost.uncommon),
  food("starfruit", "Starfruit", "rare", "Fell from a branch that grows only over green builds.", rareBoost),
  food("mooncake", "Mooncake", "rare", "Stamped with a pattern only night owls can read.", rareBoost),
  food("honeycomb", "Honeycomb", "rare", "Built cell by cell, like a good test suite.", rareBoost),
]

/** A level-up effect or a scene: a moment's look, named for now, which nothing draws yet. */
const moment = (
  id: string,
  name: string,
  rarity: Rarity,
  category: "levelUpEffect" | "scene",
  lore: string,
): ItemDef => item({ id, name, rarity, category, slot: category, lore })

const moments: ReadonlyArray<ItemDef> = [
  moment("party-popper", "Party Popper", "common", "levelUpEffect", "One string to pull, one level to cheer."),
  moment("confetti-pop", "Confetti Pop", "uncommon", "levelUpEffect", "Mostly paper, entirely earned."),
  moment("terminal-green", "Terminal Green", "uncommon", "scene", "Green on black, the way the old screens glowed."),
  moment("fireworks", "Fireworks", "rare", "levelUpEffect", "Loud enough to wake the logs."),
  moment("comet-trail", "Comet Trail", "rare", "levelUpEffect", "Draws the new level number across the sky."),
  moment("pixel-dragon", "Pixel Dragon", "epic", "levelUpEffect", "Circles twice, roars once, then naps on your gold."),
]

/**
 * The catalogue the starter rules deal from, version 7: catalogue 6's items, every one with a line of lore and the
 * pet's wear with art, and many more. An item is never taken out or renamed, since players own it.
 */
export const starterCatalog: ReadonlyArray<ItemDef> = [
  ...starterWear,
  ...foods,
  ...moments,
  ...bandStyles,
  ...moreBandStyles,
  ...sigils,
  ...moreSigils,
]

// Catalogue 6 as rules 14 dealt from it, kept so a log of rules 14 can be run again just as it ran: the same items
// with their fields of then, in the same order, since a roll picks an item by its place.

/** Catalogue 6's items in its order. */
const catalog6Order = [
  "plain-cap",
  "paper-scarf",
  "honey-biscuit",
  "sugar-plum",
  "trail-mix",
  "berry-tart",
  "starfruit",
  "knit-scarf",
  "confetti-pop",
  "terminal-green",
  "wizard-hat",
  "fireworks",
  "pixel-dragon",
  "aurora-crown",
  ...bandStyles.map((style) => style.id),
  ...sigils.map((one) => one.id),
]

/** The fields catalogue 7 gave items catalogue 6 already had, as catalogue 6 had them: no art, and less lore. */
const asInCatalog6: Readonly<Record<string, Partial<ItemDef>>> = {
  "plain-cap": { sprite: null, lore: null },
  "paper-scarf": { sprite: null, lore: null },
  "knit-scarf": { sprite: null, lore: null },
  "wizard-hat": { sprite: null, lore: null },
  "aurora-crown": { sprite: null },
  "confetti-pop": { lore: null },
  "terminal-green": { lore: null },
  "fireworks": { lore: null },
  "pixel-dragon": { lore: null },
}

/** Catalogue 6, which rules 14 dealt from. */
export const catalog6: ReadonlyArray<ItemDef> = catalog6Order.flatMap((id) => {
  const def = starterCatalog.find((one) => one.id === id)
  return def === undefined ? [] : [{ ...def, ...asInCatalog6[id] }]
})

/** Rules 14: the starter rules before catalogue 7, the same in every number. */
export const rules14: RulesConfig = { ...starterRules, version: 14, catalogVersion: 6 }
