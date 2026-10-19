import { petSprite } from "@pathofdev/schema"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { gradeV2, starterQuestPack, starterRules as rules, titleFor, xpForLevel } from "../src/index.ts"

// The landing page hard-codes the rules' numbers in plain HTML, so a change to the rules has to reach it too. Each
// test reads the numbers back out of site/index.html and checks them against the starter rules. The pet it draws is
// the profile pages' too, so its sprite is checked against the schema's.

const site = readFileSync(new URL("../../../site/index.html", import.meta.url), "utf8")

const fmt = (n: number): string => n.toLocaleString("en-US")
const matches = (pattern: RegExp): ReadonlyArray<RegExpMatchArray> => [...site.matchAll(pattern)]
const one = (pattern: RegExp): RegExpMatchArray => {
  const found = matches(pattern)
  expect(found, String(pattern)).toHaveLength(1)
  return found[0]!
}
const level = (n: number) => xpForLevel(rules.levelCurve, n)

describe("the landing page's path", () => {
  const stops = matches(
    /<div class="stop[^"]*"><div class="node">(\d+)<\/div><h3>([^<]+)<\/h3><span class="need">([\d,]+) XP<\/span>(<span class="evolve">)?/g,
  )

  it("has a stop at each title, and only there", () => {
    expect(stops.map(([, n]) => Number(n))).toEqual(rules.titles.map((t) => t.fromLevel))
  })

  it("names each stop's title and XP as the rules do", () => {
    for (const [, n, title, need] of stops) {
      expect({ title, need }).toEqual({ title: titleFor(rules, Number(n)), need: fmt(level(Number(n))) })
    }
  })

  it("marks the pet evolving at exactly the rules' levels", () => {
    expect(stops.filter(([, , , , evolve]) => evolve !== undefined).map(([, n]) => Number(n))).toEqual(
      rules.pet.evolveAt,
    )
  })
})

describe("the landing page's band", () => {
  const [, levelText, titleText] = one(/<span class="t-title">Lv (\d+) · ([^<]+)<\/span> <span class="t-edge">╞═+◇═+<\/span>\n/g)
  const shown = Number(levelText)
  const [, from, to] = one(/const lv = \{ from: (\d+), to: (\d+) \};/g)
  const [, start, end] = one(/await animateXp\((\d+), (\d+)\);/g)
  const [, idle] = one(/band\.innerHTML = bandAt\((\d+)\);/g)
  const [, still, stillTo] = one(/<span class="t-dim">([\d,]+) \/ ([\d,]+)<\/span>/g)

  it("spans the shown level, with its title", () => {
    expect({ from: Number(from), to: Number(to), title: titleText }).toEqual({
      from: level(shown),
      to: level(shown + 1),
      title: titleFor(rules, shown),
    })
  })

  it("animates within that level, and the still frame shows where it ends", () => {
    expect(Number(idle)).toBe(Number(start))
    expect(Number(start)).toBeGreaterThanOrEqual(level(shown))
    expect(Number(end)).toBeLessThan(level(shown + 1))
    expect({ still, stillTo }).toEqual({ still: fmt(Number(end)), stillTo: fmt(level(shown + 1)) })
  })
})

describe("the landing page's loot odds", () => {
  const total = Object.values(rules.loot.weights).reduce((a, b) => a + b, 0)
  const pct = (weight: number) => String(Math.round((weight / total) * 1000) / 10)
  const tiers = matches(/<span class="tier-name">(\w+)<\/span><span class="tier-pct">([\d.]+)<small>%/g)

  it("shows each rarity's base odds", () => {
    expect(Object.fromEntries(tiers.map(([, name, shown]) => [name!.toLowerCase(), shown]))).toEqual(
      Object.fromEntries(Object.entries(rules.loot.weights).map(([rarity, weight]) => [rarity, pct(weight)])),
    )
  })

  it("says the same odds in the chart's label", () => {
    const label = Object.entries(rules.loot.weights).map(([rarity, weight]) => `${rarity} ${pct(weight)}%`)
    expect(site).toContain(`aria-label="Base drop odds: ${label.join(", ")}"`)
  })

  it("gives a turn's drop chance, a prompt's at a 10 and the grade that doubles rare and better, as rubric 2 prices them", () => {
    const [, turn, at10] = one(/Each turn can drop an item, (\d+)% of the time, and each graded prompt rolls too: ([\d.]+)% of the time at a perfect 10/g)
    expect([Number(turn), Number(at10)]).toEqual([rules.loot.chancePerTurn * 100, rules.prompt.v2.loot.chanceAtTen * 100])
    const [, great] = one(/A grade of (\d+) or more doubles the odds of rare and better/g)
    expect(Number(great)).toBe(rules.prompt.v2.loot.greatAt)
    expect(rules.loot.promptGreatRareFactor).toBe(2)
  })
})

describe("the landing page's prompt XP", () => {
  it("tapers as the rules' day does", () => {
    const shown = matches(/<div><b>(\d+)%<\/b><span>(?:prompts \d+ to (\d+)|after that)<\/span><\/div>/g)
    expect(shown.map(([, pct, upTo]) => ({ upTo: upTo === undefined ? null : Number(upTo), pct: Number(pct) }))).toEqual(
      rules.prompt.perDay,
    )
  })

  it("tops out at rubric 2's maximum, in the rule, its words and the ledger", () => {
    const { maxXp } = rules.prompt.v2
    expect(one(/<h3>Up to (\d+) XP a prompt<\/h3>/g)[1]).toBe(String(maxXp))
    expect(one(/so a perfect 10 earns (\d+)\./g)[1]).toBe(String(maxXp))
    expect(one(/<small>your grade × ([\d.]+)<\/small>/g)[1]).toBe(String(maxXp / 10))
    expect(one(/<td class="xp">up to (\d+)<\/td>/g)[1]).toBe(String(maxXp))
  })
})

describe("the landing page's XP table", () => {
  // Each row's text, keyed by the event type it shows.
  const rows: Record<keyof typeof rules.xp, string> = {
    "first.contribution": "First contribution to a repo",
    "change.merged": "Pull request merged",
    "bug.fixed": "Bug fixed",
    "review.acted_on": "Review feedback acted on",
    "issue.closed": "Issue closed",
    "repo.explored": "New repo explored",
    "tests.green": "Red tests turned green",
    "streak.day": "Streak day",
    "commit.made": "Commit",
    "change.opened": "Pull request opened",
  }
  const cap = (dailyCap: number | null) => (dailyCap === null ? "none" : `${dailyCap} a day`)

  it("lists every XP source the rules pay, with its cap, XP and GitHub check", () => {
    for (const [type, text] of Object.entries(rows) as Array<[keyof typeof rules.xp, string]>) {
      const source = rules.xp[type]
      const [, gh, shownCap, shownXp] = one(
        new RegExp(`<td class="what">${text}( <span class="gh">GitHub</span>)?(?:<small>[^<]*</small>)?</td><td class="cap">([^<]+)</td><td class="xp">(\\d+)</td>`, "g"),
      )
      expect({ type, github: gh !== undefined, cap: shownCap, xp: Number(shownXp) }).toEqual({
        type,
        github: source.tier === "verified",
        cap: cap(source.dailyCap),
        xp: source.xp,
      })
    }
  })

  it("covers every XP source", () => {
    expect(Object.keys(rows).sort()).toEqual(Object.keys(rules.xp).sort())
  })
})

describe("the landing page's pet facts", () => {
  it("states the rules' happy bonus, threshold and daily drift", () => {
    expect(one(/<b>\+(\d+)%<\/b><span>XP while your pet is happy\. Keep its mood above (\d+)\./g).slice(1)).toEqual([
      String(rules.pet.happyXpBonusPct),
      String(rules.pet.happyAbove),
    ])
    expect(one(/<b>−(\d+)<\/b><span>mood for every day/g)[1]).toBe(String(rules.pet.moodDecayPerDay))
    expect(one(/<b>(\d+)<\/b><span>rest day a week/g)[1]).toBe(String(rules.streak.restDaysPerWeek))
  })
})

describe("the landing page's pet", () => {
  it("draws the schema's sprite, in its colours", () => {
    const [, rows] = one(/const sprite = \[\n([^\]]*)\];/g)
    const [, colors] = one(/const colors = (\{[^}]*\});/g)
    expect(JSON.parse(`[${rows!.trim().replace(/,$/, "")}]`)).toEqual(petSprite.rows)
    expect(JSON.parse(colors!.replace(/(\w+):/g, '"$1":'))).toEqual(petSprite.palette)
  })
})

describe("the landing page's rubric card", () => {
  const [, sample] = one(/<p class="sample">([^<]+)<\/p>/g)
  const [, body] = one(/const rubric = \[\n([^\]]*(?:\][^;][^\]]*)*)\];/g)
  const shown = [...body!.matchAll(/\["([a-z ]+)", (\d+), "[^"]*"\]/g)].map(([, name, n]) => ({
    measure: name!.replace(/ (\w)/g, (_, c: string) => c.toUpperCase()),
    score: Number(n),
  }))
  const scores = Object.fromEntries(shown.map(({ measure, score }) => [measure, score]))
  const content = Object.keys(rules.prompt.v2.weights)

  it("names rubric 2's measures in its order: the content ones, then craft and tone", () => {
    expect(shown.map(({ measure }) => measure)).toEqual([...content, "craft", "tone"])
  })

  it("shows the grade rubric 2 gives those scores, and the XP it earns, on the card and in the session", () => {
    const grade = gradeV2(rules.prompt.v2, {
      rubricVersion: 2,
      kind: "task",
      measures: {
        intent: scores.intent!,
        grounding: scores.grounding!,
        why: scores.why!,
        successShape: scores.successShape!,
        scope: scores.scope!,
        forward: scores.forward!,
        craft: scores.craft!,
        tone: scores.tone!,
      },
      spelledClean: true,
      words: sample!.split(/\s+/).length,
      grader: "haiku",
    })
    const xp = Math.floor((rules.prompt.v2.maxXp * grade) / 10)
    expect(one(/<span class="g">([\d.]+)<small> \/ 10<\/small><\/span><span class="x">\+(\d+) XP<\/span>/g).slice(1)).toEqual([
      String(grade),
      String(xp),
    ])
    const session = matches(/✦ Graded ([\d.]+)<\/span><span class="t-dim">\/10<\/span> +<span class="t-xp">\+(\d+) XP/g)
    expect(session.map(([, g, x]) => [g, x])).toEqual([
      [String(grade), String(xp)],
      [String(grade), String(xp)],
    ])
    const [, start, end] = one(/await animateXp\((\d+), (\d+)\);/g)
    expect(Number(end) - Number(start)).toBe(xp)
  })
})

describe("the landing page's quests", () => {
  const cards = matches(/<article class="quest"[^>]*><h3>([^<]+)<\/h3><span class="cadence tag">\w+<\/span><p>([^<]+)<\/p><div class="reward"><span>\+(\d+) XP<\/span><span class="g">● (\d+) gold<\/span>/g)

  it("says each quest as the starter pack does, with its XP and gold", () => {
    expect(cards.length).toBeGreaterThan(0)
    for (const [, title, description, xp, gold] of cards) {
      const quest = starterQuestPack.quests.find((one) => one.title === title)
      expect(quest, title).toBeDefined()
      expect({ title, description, xp: Number(xp), gold: Number(gold) }).toEqual({
        title,
        description: quest!.description,
        xp: quest!.rewards.xp,
        gold: quest!.rewards.gold,
      })
    }
  })
})
