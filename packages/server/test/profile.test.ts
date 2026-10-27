import { it } from "@effect/vitest"
import type { BadgeProgress, Gauge } from "@pathofdev/engine"
import { initialState, project } from "@pathofdev/engine"
import type { AchievementDef, Privacy, Snapshot } from "@pathofdev/schema"
import { isShown, privacyOf, profileSections, QualityDimension } from "@pathofdev/schema"
import { Schema } from "effect"
import { describe, expect } from "vitest"
import type { PublicBadge } from "../src/index.ts"
import { catalog, escapeHtml, gaugeOf, profileOf, profilePage, rules } from "../src/index.ts"
import { start } from "./fixtures.ts"

// What a public page shows, as properties over any snapshot and any privacy: `profileOf` is the allow-list between a
// save and the web, so a section is there only when the player shows it, a field it never names never reaches the
// page, and what a player typed changes the page's text, never its markup. The badges are the rules' own: a held id
// the rules don't define is a canary, and a locked badge's progress shows only beside the stats it would tell.
//
//   drawn privacy, numbers, names, badges, canaries ─▶ readOf ─▶ profileOf ─▶ profilePage
//     canaries sit in fields no page shows (displayName, commands, claims, items, the egg, an undefined badge id) and
//     in shown ones

/** A string found nowhere else on a page, so finding it means its field reached the page. */
const Canary = Schema.String.check(Schema.isPattern(/^zq[a-z0-9]{10}zq$/))

/** Text built to break markup. */
const Hostile = Schema.Array(
  Schema.Literals(["<", ">", "&", '"', "'", "a", "/", "=", " ", "<script>", " onerror=", "javascript:", "</style>", "🐉"]),
).check(Schema.isMaxLength(10))

const Shown = Schema.optionalKey(Schema.Boolean)
const DrawnPrivacy = Schema.Struct({ public: Schema.Boolean, badges: Shown, pet: Shown, streak: Shown, stats: Shown })

const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }))
const Grade = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))

const defs: ReadonlyArray<AchievementDef> = rules.achievements

/** Per badge the rules define: null while locked, else the days after `start` it was earned. */
const Earned = Schema.Array(Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 400 })))).check(
  Schema.isMinLength(defs.length),
  Schema.isMaxLength(defs.length),
)

/** Per badge, a count its gauges read: past the goal or short of it. */
const Counted = Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000 }))).check(
  Schema.isMinLength(defs.length),
  Schema.isMaxLength(defs.length),
)

const Drawn = Schema.Struct({
  privacy: DrawnPrivacy,
  name: Hostile,
  hatched: Schema.Boolean,
  mood: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  numbers: Schema.Struct({ total: Count, into: Count, level: Count, prestige: Count, days: Count, best: Count, graded: Count }),
  grades: Schema.Array(Grade).check(
    Schema.isMinLength(QualityDimension.literals.length),
    Schema.isMaxLength(QualityDimension.literals.length),
  ),
  earned: Earned,
  counted: Counted,
  shownCanaries: Schema.Struct({ pet: Canary }),
  hiddenCanaries: Schema.Struct({ displayName: Canary, command: Canary, claim: Canary, item: Canary, egg: Canary, badge: Canary }),
})
type Drawn = typeof Drawn.Type

const player = {
  id: "01K6ZQ8W3J5V7XKQ2M4N6P8R9T",
  githubUserId: 1,
  githubLogin: "ada",
  displayName: "Ada",
  createdAt: start,
}

const base = project(
  initialState({ characterName: "Ada", timezone: "UTC", now: start }),
  { rules, catalog, questPacks: [], now: start },
  { player, serverId: `online-${player.id}`, streamEpoch: 1, cursor: 0 },
)

const dayAfter = (days: number): string => new Date(Date.parse(start) + days * 86_400_000).toISOString()

/** A badge's gauges at a drawn count: the count against its goal, and for an average a mean on its scale too. */
const gaugesAt = (def: AchievementDef, count: number): ReadonlyArray<Gauge> => {
  const { criterion } = def
  if (criterion.kind === "count") return [{ current: count, goal: criterion.atLeast, sense: "atLeast" }]
  const covered: Gauge = { current: count, goal: criterion.over, sense: "atLeast" }
  return criterion.of === "promptGrade"
    ? [covered, { current: (count % 101) / 10, goal: criterion.atLeast, sense: "atLeast" }]
    : [covered, { current: count % 101, goal: criterion.below, sense: "below" }]
}

/** How far each locked badge is, as the engine would read it off the drawn counts. */
const progressOf = (drawn: Drawn): ReadonlyArray<BadgeProgress> =>
  defs.flatMap((def, i) => (drawn.earned[i] === null ? [{ id: def.id, gauges: gaugesAt(def, drawn.counted[i] ?? 0) }] : []))

/** A snapshot with the drawn numbers and names, and canaries in the fields no page shows. */
const snapshotOf = (drawn: Drawn, name: string): Snapshot => {
  const { numbers, hiddenCanaries: hidden } = drawn
  const dimensions = Object.fromEntries(QualityDimension.literals.map((quality, i) => [quality, drawn.grades[i]! / 10]))
  return {
    ...base,
    player: { ...base.player, displayName: hidden.displayName },
    character: {
      ...base.character,
      name,
      level: numbers.level,
      prestige: numbers.prestige,
      xp: { ...base.character.xp, total: numbers.total, intoLevel: numbers.into, forNextLevel: numbers.into + 100 },
      streak: { ...base.character.streak, days: numbers.days, best: numbers.best },
    },
    pet: drawn.hatched ? { species: "fox", name: drawn.shownCanaries.pet, form: 1, mood: drawn.mood, equipped: {} } : null,
    egg: drawn.hatched ? null : { species: "owl", name: hidden.egg },
    achievements: [
      ...defs.flatMap((def, i) => {
        const days = drawn.earned[i]
        return days === null || days === undefined ? [] : [{ id: def.id, unlockedAt: dayAfter(days) }]
      }),
      { id: hidden.badge, unlockedAt: start },
    ],
    claims: [{ claimId: player.id, kind: "change.merged", subject: `${hidden.claim}/repo#1`, status: "pending" }],
    inventory: [{ id: player.id, itemId: hidden.item, acquiredAt: start, source: { kind: "drop", ref: hidden.item }, dye: null }],
    stats: {
      ...base.stats,
      commands: { [`/${hidden.command}`]: 3 },
      prompts: { ...base.stats.prompts, graded: numbers.graded },
      grades: { best: drawn.grades[0]! / 10, dimensions: dimensions as Snapshot["stats"]["grades"]["dimensions"] },
    },
  }
}

const viewOf = (drawn: Drawn, name = drawn.name.join("")) => {
  const privacy: Privacy = privacyOf(drawn.privacy)
  const profile = profileOf("ada", { snapshot: snapshotOf(drawn, name), badgeProgress: progressOf(drawn) }, privacy)
  return { privacy, profile, page: profilePage(profile, "https://pathof.dev/u/ada") }
}

/** How close a locked badge is, as the list orders them: a count's share of its goal, an average none. */
const closeness = (badge: PublicBadge): number =>
  badge.criterion.kind === "count" && badge.gauges !== null && badge.gauges[0] !== undefined
    ? Math.min(1, badge.gauges[0].current / badge.gauges[0].goal)
    : 0

/** Whether a locked badge's progress may show: beside the stats, and the streak or pet it would tell. */
const tells = (privacy: Privacy, badge: PublicBadge): boolean => {
  const { criterion } = badge
  const section = criterion.kind !== "count"
    ? "stats"
    : criterion.of.kind === "streak"
    ? "streak"
    : criterion.of.kind === "hatched"
    ? "pet"
    : "stats"
  return isShown(privacy, "stats") && isShown(privacy, section)
}

const isSorted = (values: ReadonlyArray<number>): boolean => values.every((value, i) => i === 0 || values[i - 1]! >= value)

describe("profileOf", () => {
  it.prop("has a section exactly when the player shows it", [Drawn], ([drawn]) => {
    const { privacy, profile } = viewOf(drawn)
    for (const section of profileSections) expect({ section, has: section in profile }).toEqual({ section, has: isShown(privacy, section) })
  })

  it.prop("shows the snapshot's own numbers", [Drawn], ([drawn]) => {
    const { profile } = viewOf(drawn)
    const { numbers } = drawn
    expect(profile.character).toMatchObject({ level: numbers.level, prestige: numbers.prestige })
    expect(profile.character.xp).toEqual({ total: numbers.total, intoLevel: numbers.into, forNextLevel: numbers.into + 100 })
    if (profile.streak !== undefined) expect(profile.streak).toMatchObject({ days: numbers.days, best: numbers.best })
    if (profile.stats !== undefined) expect(profile.stats.graded).toBe(numbers.graded)
  })
})

describe("profileOf: badges", () => {
  it.prop("counts the earned badges the rules define, of all they define, and lists each once", [Drawn], ([drawn]) => {
    const { badges } = viewOf(drawn).profile
    if (badges === undefined) return
    expect(badges.of).toBe(defs.length)
    expect(badges.earned).toBe(drawn.earned.filter((days) => days !== null).length)
    expect([...badges.list.map((badge) => badge.id)].sort()).toEqual(defs.map((def) => def.id).sort())
    expect(badges.list.filter((badge) => badge.unlockedAt !== null)).toHaveLength(badges.earned)
  })

  it.prop("lists the earned newest first, then the locked closest first", [Drawn], ([drawn]) => {
    const { badges } = viewOf(drawn).profile
    if (badges === undefined) return
    const earned = badges.list.slice(0, badges.earned)
    const locked = badges.list.slice(badges.earned)
    expect(earned.every((badge) => badge.unlockedAt !== null)).toBe(true)
    expect(isSorted(earned.map((badge) => Date.parse(badge.unlockedAt ?? "")))).toBe(true)
    expect(isSorted(locked.map(closeness))).toBe(true)
  })

  it.prop("tells how far a locked badge is only while the player shows their stats, and the streak or pet it tells", [Drawn], ([drawn]) => {
    const { privacy, profile } = viewOf(drawn)
    const measured = new Map(progressOf(drawn).map((one) => [one.id, one.gauges]))
    for (const badge of profile.badges?.list ?? []) {
      const expected = badge.unlockedAt === null && tells(privacy, badge) ? measured.get(badge.id) : null
      expect({ id: badge.id, gauges: badge.gauges }).toEqual({ id: badge.id, gauges: expected })
    }
  })
})

describe("profilePage", () => {
  it.prop("never shows a field no page names, nor a section the player hides", [Drawn], ([drawn]) => {
    const { privacy, page } = viewOf(drawn)
    for (const canary of Object.values(drawn.hiddenCanaries)) expect(page).not.toContain(canary)
    expect(page.includes(drawn.shownCanaries.pet)).toBe(isShown(privacy, "pet") && drawn.hatched)
  })

  it.prop("says how many badges are earned of how many, and draws progress only beside shown stats", [Drawn], ([drawn]) => {
    const { privacy, profile, page } = viewOf(drawn)
    const { badges } = profile
    expect(page.includes('aria-labelledby="badges"')).toBe(badges !== undefined)
    if (badges === undefined) return
    expect(page).toContain(`<b>${badges.earned}</b> of ${badges.of}`)
    const unmeasured = page.split('<span class="when">Locked</span>').length - 1
    expect(unmeasured).toBe(badges.list.filter((badge) => badge.unlockedAt === null && !tells(privacy, badge)).length)
  })

  it.prop("draws a badge's name and what earns it as text, so the markup is the same whatever they hold", [Drawn], ([drawn]) => {
    const { profile } = viewOf(drawn)
    if (profile.badges === undefined) return
    const named = (name: string, about: string) =>
      profilePage(
        { ...profile, badges: { ...profile.badges!, list: profile.badges!.list.map((badge) => ({ ...badge, name, about })) } },
        "https://pathof.dev/u/ada",
      )
    const marked = `zqh${drawn.name.join("")}hqz`
    const page = named(marked, marked)
    expect(page.replaceAll(escapeHtml(marked), "TEXT")).toBe(named("zqhhqz", "zqhhqz").replaceAll("zqhhqz", "TEXT"))
    expect(page).not.toMatch(/<script/i)
  })

  it.prop("draws a character name as text, so the markup is the same whatever it holds", [Drawn], ([drawn]) => {
    // The name between two markers, so its escaped form is found in the page and nowhere else.
    const marked = `zqh${drawn.name.join("")}hqz`
    const page = viewOf(drawn, marked).page
    const plain = viewOf(drawn, "zqhhqz").page
    expect(page.replaceAll(escapeHtml(marked), "NAME")).toBe(plain.replaceAll("zqhhqz", "NAME"))
    expect(page).not.toMatch(/<script/i)
  })
})

describe("the pet's wear", () => {
  const ids = {
    hat: "01K6ZQ8W3J0000000000000H01",
    cape: "01K6ZQ8W3J0000000000000C01",
    lost: "01K6ZQ8W3J0000000000000L01",
  }
  /** Ada's pet wearing what `equipped` says, the hat and the cloak owned and defined, the lost entry owned only. */
  const wearing = (equipped: NonNullable<Snapshot["pet"]>["equipped"]) => {
    const owned = (id: string, itemId: string) => ({
      id,
      itemId,
      acquiredAt: start,
      source: { kind: "drop" as const, ref: "0" },
      dye: null,
    })
    const snapshot: Snapshot = {
      ...base,
      pet: { species: "fox", name: "Pixel", form: 1, mood: 80, equipped },
      inventory: [owned(ids.hat, "wizard-hat"), owned(ids.cape, "night-cloak"), owned(ids.lost, "no-such-item")],
      items: catalog.filter((item) => item.id === "wizard-hat" || item.id === "night-cloak"),
    }
    const profile = profileOf("ada", { snapshot, badgeProgress: [] }, privacyOf({ public: true }))
    return { profile, page: profilePage(profile, "https://pathof.dev/u/ada") }
  }

  it("lists what the pet wears in the pet's slot order, and leaves out wear the snapshot can't name", () => {
    const { profile } = wearing({ back: ids.cape, head: ids.hat, hand: ids.lost })
    expect(profile.pet?.wearing).toEqual([
      { slot: "head", name: "Wizard Hat", sprite: "wizard-hat" },
      { slot: "back", name: "Night Cloak", sprite: "night-cloak" },
    ])
  })

  it("draws the pet in its wear on the dressed canvas, and says what it wears", () => {
    const { page } = wearing({ head: ids.hat, back: ids.cape })
    expect(page).toContain('<svg class="sprite dressed" viewBox="0 0 20 17"')
    expect(page).toContain('aria-label="Pixel, the fox, wearing Wizard Hat and Night Cloak"')
    expect(page).toContain("Wears Wizard Hat and Night Cloak")
  })

  it("draws a pet that wears nothing as it always was", () => {
    const { profile, page } = wearing({})
    expect(profile.pet?.wearing).toEqual([])
    expect(page).toContain('<svg class="sprite" viewBox="0 0 14 12" role="img" aria-label="Pixel, the fox">')
    expect(page).not.toContain("Wears ")
  })
})

describe("gaugeOf", () => {
  const Tenths = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))
  const Short = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 0.099 }))

  it.prop("never shows an average grade just short of its mark as at it", [Tenths, Short], ([mark, short]) => {
    const goal = mark / 10
    const current = Math.max(0, goal - short - 1e-6)
    const criterion = { kind: "average", of: "promptGrade", atLeast: goal, over: 1 } as const
    const { text } = gaugeOf(criterion, [
      { current: 1, goal: 1, sense: "atLeast" },
      { current, goal, sense: "atLeast" },
    ])
    const shown = Number(/Avg ([\d.]+)/.exec(text)?.[1])
    expect(shown).toBeLessThanOrEqual(current)
    if (goal > 0) expect(shown).toBeLessThan(goal)
  })

  const Def = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: defs.length - 1 }))

  it.prop("fills a count's ring by its share of the goal, and draws none for an average", [Def, Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000 }))], ([i, count]) => {
    const def = defs[i]!
    const { share, text } = gaugeOf(def.criterion, gaugesAt(def, count))
    if (def.criterion.kind === "count") {
      expect(share).toBe(Math.min(1, count / def.criterion.atLeast))
      expect(text).toMatch(/^[\d,]+ \/ [\d,]+$/)
    } else {
      expect(share).toBeNull()
    }
    expect(text.length).toBeGreaterThan(0)
  })
})
