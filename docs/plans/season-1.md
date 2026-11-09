# Plan: Season 1, the opening season, and the devpass (2026-11-09)

Planned against main at 38151e8 (#71: engine 16, rules 16, catalogue 8 of 194 items, mod 0.14.0, migrations up to
0016). File references are as of that commit. The numbers below come from `starter.ts` and `starter-quests.ts`, not
from play data: with four players there is not enough of it to tune on.

## Goal
Give the game a public start: **Season 1**, eight weeks with a start and an end, and a **devpass** (a battle pass)
that every bit of ordinary play fills. Strangers who hear of it on LinkedIn get a reason to join now: a fair start on
the pass whatever their level, and rewards that exist only this season. Players get a goal they can see every day:
today's pass XP against the day's cap, and the next tier.

The core loop stays as it is: prompts, work, missions, loot and the pet. The season is a second, short track beside the
level, and it never changes what play earns.

## Non-goals
- **Payments.** The beta is free and open source. "Free vs premium" below lists what a paid track would need.
- **A leaderboard on day one** (see "Season leaderboard").
- **New mission kinds.** The season's missions are the existing dailies and weeklies (see "What fills the pass").
  Seasonal quests (`QuestCadence` already names `seasonal`) wait for Season 2.
- **Resetting anything players own or have earned:** levels, XP, inventory, gold, badges, streaks.
- **A heavier band.** The season adds no row to the band and no permanent element to it (see "Surfaces").
- **Season 2's content.** This plan makes seasons data, so Season 2 is a rules entry and a catalogue bump.

## Facts found in the code (they drive the design)
- **The engine's only clock is the log row's receipt time** (`Context.now`, `schema/src/step.ts`), set from Effect's
  `Clock` by the server (`server/src/game.ts` `nowIso`). Days are local days in the player's zone (`engine/src/days.ts`
  `localDay`, `startOfDay`), and caps, streaks and missions all count by them.
- **A client event counts on its own local day**, held to today at most (`step.ts` `applyClient`: `day = min(eventDay,
  today)`). The edge rejects events more than 7 days old (`server/src/edge.ts` `maxAge`), so a day can still change
  for 7 days after it ends, and then never again. `progress.tallies` keeps the last 7 days for that reason.
- **Rules are retroactive** (`appliesFrom: null`), and the server runs every input under one rules config
  (`game.ts`). A number that must replay as it was priced is frozen, as rubric 1's are ("grading v2"). Old catalogues
  are kept as data (`catalog6`, `catalog7` with `rules14`, `rules15` in `starter.ts`), because **a roll picks an item
  by its place in the pool**.
- **Missions already know dated windows:** `QuestDef.availableFrom` and `availableUntil` (`schema/src/quests.ts`), and
  a mission completes once per window (`holdings.completedQuests`).
- **XP rates** (`starterRules`): a v2 prompt pays `15 × grade / 10`, the first 20 of a local day in full, the next
  20 at half, then 10% (`prompt.perDay`), times the sigil (×1.2 to ×2.5). Then streak 10 a day up to 70, commits 3
  each (20 a day), green tests 20 (5 a day), explored repos 25 (3 a day), merges 250, or 120 in one's own repo, a
  quarter of either for a tiny diff, **uncapped**. Dailies pay 30–60 XP, weeklies 120–300, and food and mission
  boosts add 10–15%. The grading experiment's mean v2 grade was 7.31, so a typical prompt pays about 11 XP.
- **Gold:** a steady day earns about 240 (rules comment on `shop`). The shop never sells a sigil or XP food, and gold
  never buys XP (`engine/src/shop.ts` `buysXp`).
- **Reward drops by name** already exist: `rewardDrop` in `step.ts` lands a named item through a roll of chance 1 and
  refuses to hand out a sigil by name.
- **The `title` item category exists** (`primitives.ts` `ItemCategory`), but no item uses it and no slot holds it.
  The band's level display shows `view.title`, which `project.ts` takes from `titleFor(rules, level)`.
- **The band folds away by default** (`mod/hooks/collapse.ts`, `band: auto` since #49). The status line under the
  prompt carries the essentials, and drops its parts from the right when the row is narrow (`mod/hooks/status.ts`).
  Since #49, the rule has been that the band opens only for a moment of play.
- **The pane has five tabs** (`mod/hooks/pane.ts` `tabs`): Inventory, Shop, Stats, Missions, Welcome.
- **Profile sections** are a list with defaults (`schema/src/profile.ts` `profileSections`, `defaultShown`). A page is
  private until the player makes it public, and `history` shows how a new section can start hidden.
- **The site is static HTML** (`site/`), with no build step. `engine/test/site-pages.test.ts` lists every page and
  reads back the numbers marked `data-rule` against the rules. The preview card is rendered from `docs/og-card.html`.
- **The companion decodes the snapshot leniently.** `contract/snapshot.json` and `contract/unread.txt` fail CI when a
  field is added and not listed.
- **The online server tells mods about a newer version** (`mod/hooks/update.ts`): once on the band, and as a line in
  the pane.

## Decisions (*plan*, for the owner to confirm in Open questions)
1. **Season 1: Trailhead** runs **8 weeks**, from **Monday 4 January to Sunday 28 February 2027**, by local days in
   each player's zone.
2. **Levels, XP, inventory, gold, badges and the streak carry over.** Only the pass resets: its XP, its tier and its
   rested pool.
3. **30 tiers** for 15,000 pass XP. Tiers 1–5 cost 200 each and tiers 6–30 cost 560 each. Past tier 30, every 1,000 pass
   XP pays 100 gold.
4. **The pass fills from both:** all XP earned in ordinary play counts, up to **300 per local day**, and each completed
   mission adds a flat bonus on top: **+30 for a daily, +120 for a weekly**.
5. **Catch-up is "rested":** each season day without pass XP adds 150 to a pool, which holds at most 600, and the
   season starts with it full. While the pool lasts, play XP counts double.
6. **Rewards are fixed per tier and granted on reaching it**, with no claim step and no randomness. Six items are
   exclusive to Season 1 and never come back. A new **Trailblazer** badge goes with tier 30.
7. **Free only.** There is one track for everyone, with no premium lane.
8. **A season is rules data** (`rules.seasons`), frozen once it starts, and a test pins it. Engine 17, rules 17 and
   migration `0017_seasons` add the machinery with no season in the rules. Rules 18 and catalogue 9 add Season 1.
9. **Local players get the same season**, from the same rules.
10. **No leaderboard** in Season 1. One can come later, as an opt-in.

## Season shape
**Length: 8 weeks (56 days).** Why eight:
- A casual player (3 days a week) reaches tier 26 of 30 in eight weeks, and a regular one finishes by week 7. At six
  weeks the casual player stops near tier 21, too far short. At twelve the daily players finish in week 5 and coast
  for seven weeks.
- It is long enough for a LinkedIn post to keep bringing people in while the season runs, and short enough for the owner
  to learn from it and ship Season 2 in spring.
- **Monday to Sunday,** so the season holds exactly eight weekly windows (`weekOf` starts weeks on Monday), and no
  weekly is cut in half at either end.

**Dates: Monday 4 January to Sunday 28 February 2027** (Open question 1). This leaves eight weeks from today to build
and settle the season, and avoids the December holidays, which would skew the first season's numbers. A New Year start
also suits a game about better habits. The alternative is Monday 7 December 2026 to Sunday 31 January 2027.

**Time zones: local days, like everything else.** The season covers the local days `startsOn` to `endsOn` in each
player's zone, so it begins at their own midnight, as a daily does.
- It matches the caps, the streak and the missions. Pass XP counts per local day, so the season must too, or a day
  would be half in and half out.
- So the start runs across about 25 hours worldwide: Kiritimati (UTC+14) at 10:00 UTC on Sunday 3 January, and
  Pago Pago (UTC−11) at 11:00 UTC on Monday 4 January. **Post the LinkedIn announcement after 12:00 UTC on Monday**,
  when the season has begun in every zone that has people. The Season 1 page shows "started" or a countdown in the
  reader's own zone.
- `timezone.changed` can move a player's day by up to about a day, which is true of the caps today. Flipping zones
  only moves between two dates, so it gains at most one day's cap, and only once. That is cosmetic, and bounded.

**The end.**
- Play on a local day after `endsOn` earns no pass XP. Play dated inside the season still counts when it arrives
  late (an offline queue), until the edge's 7-day limit. So the season **settles on 7 March**, and nothing can change
  it after that.
- On the first step after the season's last local day, the engine emits `season.ended` once, with the final tier.
  The mod plays one moment for it and the Season tab shows the result. A tier reached while the season settles still
  grants its rewards.
- There is nothing to claim. Rewards land as each tier is reached, so nothing is lost at the end.
- Between seasons there is no pass. The status line's part goes, and the Season tab shows the last season's result
  and "Season 2 is coming" once rules name it.

**What carries over, and why.**
- **Levels and XP carry over.** The level curve (`base 100, exponent 1.66`) is tuned for a long climb: Legend, level
  100, takes about a year of steady play (208,900 XP). A reset would take that from the two daily players, who are the
  game's core, and it would make early levels trivial again while their sigils, tuned to their stage, still apply. The
  season's fairness to newcomers lives on the pass, where everyone starts at 0, and not on the level.
- **Inventory and gold carry over.** `starter.ts` says it outright: "An item is never taken out", since players own
  it. Taking items away would also break `equipped` and every profile that draws them.
- **Badges carry over.** They are "kept for good once earned" (`achievements.ts`), and their ids never change.
- **The streak carries over.** It measures a habit, not a season, and resetting it would punish the people the season
  wants to keep.
- **One continuous state.** Replay runs the whole log through one state. A reset would need a season boundary inside
  replay, a second kind of state, and a migration at each season's end. Carrying over needs none of these.
- **What resets** each season: the pass XP, the tier, the rested pool and the day counters. The record of the season
  that ended (its tier and XP) is kept for good in `holdings.seasons`.

## The devpass
### What fills the pass
**Both ordinary XP and missions,** with a cap on the first and a fixed bonus for the second:
```
on every XP grant on a season day d (any reason but dev; never an xp.carried):
  room     = pass.perDay − counted[d]                                    300 a local day
  play     = min(amount, max(0, room))
  boost    = min(play, rested)                                           rested pool, starts at 600
  pass.xp += play + boost;  counted[d] += play;  rested −= boost
on every mission completed in a window that falls in the season:
  pass.xp += pass.missions[cadence]                                      daily 30, weekly 120, outside the cap
on the first pass XP of a local day d, after the last day with any (lastDay):
  rested = min(rested.max, rested + rested.perDay × (days strictly between lastDay and d))   150 a day, at most 600
```
- **Every XP counts the same:** prompts, work, the streak and mission rewards, after the sigil and boosts, exactly as
  the bar shows it. The player reads one rule: "everything you earn fills the pass too, up to 300 a day".
- **The cap is what keeps it fair.** A regular player's day (about 500 XP, see "Pacing") and a heavy player's day
  (about 1,700, merges included) both count 300. So the pass rewards the days played and the missions done, not the
  hours. That is the game's own line: reward quality, not volume.
- **The mission bonus is the season's "missions".** The three dailies and the weeklies already point at better habits.
  Each one now also moves the pass, which gives a visible goal every day without a new mission kind. Each mission
  completes once per window (`completedQuests`), so the bonus can't be farmed.
- **Rested is the catch-up.** It doubles real play XP and adds nothing by itself, so not playing never earns. The
  season starts with the pool full (600), so a stranger who joins in week 4 starts rested, just as everyone did on day
  one.

### Tiers
30 tiers, each with its own cost in rules data: **200 for tiers 1–5** (1,000 in all) and **560 for tiers 6–30**
(14,000). The total is **15,000**.
- The cheap first tiers land on the first day: a casual player's first day gives tier 2, a regular's tier 3. A
  stranger from LinkedIn sees the pass move within an hour of installing.
- **Past tier 30, every 1,000 pass XP pays 100 gold.** The heavy players then keep a reason to play the season out, in
  gold, which never buys XP.

### Pacing
These are the plan's assumptions, from the rules as they stand. A v2 prompt averages 11 XP (grade 7.3), and taper,
caps and the 300 cap apply. `engine/test/season-pacing.test.ts` (PR 2) plays these three players through `step` and
pins the results.

| | casual | regular | heavy |
|---|---|---|---|
| days played | 3 a week (24) | 5 a week, Mon–Fri (40) | every day (56) |
| prompts a day | 15 → 164 XP | 30 → 274 XP (×1.5 sigil: 411) | 50 → 340 XP before sigil |
| other XP a day | streak ~15, commits 12, a green run 20, one daily ~45 | streak ~50, commits 30, tests 40, explore 25, two dailies ~90 | caps on commits, tests, explore; merges; three dailies |
| XP earned a day played | **~256** | **~500** | **~1,700** |
| counted from play | 256 (under the cap) | 300 | 300 |
| rested, a day played | up to 256: the pool refills 600 a week (4 days off) | 300 on Mondays (the weekend's 300) | none after the first 600 |
| mission bonus | 1 daily a day (+30), 1 weekly a week (+120) | 2 dailies (+60), 2 weeklies (+240) | 3 dailies (+90), 3 weeklies (+360) |
| pass XP a week | ~1,620 | ~2,340 (2,640 in week 1) | ~3,090 (3,690 in week 1) |
| first day | 542 → tier 2 | 660 → tier 3 | 690 → tier 3 |
| tier 10 (the title) | day 15, week 3 | day 10, week 2 | day 8 |
| **at the end** | **~13,280: tier 26 of 30** | **finishes on day 43** (Mon, week 7); 19,020 in all, 4 gold tiers | **finishes on day ~33** (week 5); ~25,300, 10 gold tiers |

- **Casual gets most of it:** tier 26 of 30, which includes five of the six exclusives (all but the tier 30 scene).
  Rested adds about 5,100 of their 13,280.
- **A regular player finishes** in week 7, with a week to spare for a missed one.
- **Edge cases:**
  - Playing **one day a week** (8 days) gives about 4,340, tier 10, so the Pioneer title is in reach of anyone who
    plays weekly.
  - A **regular who starts in week 4** gets about 12,000, tier 24.
  - No one finishes before about day 33, even with forged events: the cap holds every day to 300 plus the
    missions, and each mission pays once per window.

### Anti-farm, consistent with the rules
- **The daily cap** counts by the same local day the fact caps use, so an uncapped fact (a merge, prompts past the
  taper) still counts only 300 a day toward the pass.
- **Rested only multiplies real play,** and refills only on calendar days with no pass XP. Playing less never earns
  more than playing.
- **Mission bonuses** are once per mission per window, as their rewards are.
- **Dev XP never counts** (`reason: dev`, local dev mode only). Neither does `xp.carried` (bookkeeping, `step.ts`).
- **No reward buys an XP edge:** no sigil, at any tier, as `rewardDrop` already refuses one. Gold rewards are spent in
  a shop that sells no XP. The pass's XP food comes from play, which is where XP food comes from.
- **Reported tier:** a modified mod can forge events today, and so the pass. Its rewards are cosmetic and the cap
  bounds a forger to a heavy player's pace. That is also why the pass gets no leaderboard yet.

## Rewards
Every reward is named in rules data and lands when its tier is reached. Items arrive as an inventory entry
(`source: { kind: "season", ref: "s1/<tier>" }`) and gold as `gold.changed` with reason `season`. Nothing rolls. A
reward the player already owns is a duplicate, which trades in like any other (re-roll or salvage). ★ marks the
season-exclusive items, all new and in need of art or a look, as listed below.

| tier | cost | total | reward | rarity | |
|---|---|---|---|---|---|
| 1 | 200 | 200 | 100 gold | | |
| 2 | 200 | 400 | Sugar Plum (treat) | uncommon | |
| 3 | 200 | 600 | Kite Hill (scene) | common | |
| 4 | 200 | 800 | Trail Mix (XP food) | common | |
| 5 | 200 | 1,000 | Rope Rule (top edge) | common | |
| 6 | 560 | 1,560 | 150 gold | | |
| 7 | 560 | 2,120 | Trail Pack (pet, back) | uncommon | |
| 8 | 560 | 2,680 | ★ **Trailhead** (scene) | rare | new, art |
| 9 | 560 | 3,240 | Matcha Latte (XP food) | uncommon | |
| 10 | 560 | 3,800 | ★ **Pioneer** (title) | rare | new, text only |
| 11 | 560 | 4,360 | 200 gold | | |
| 12 | 560 | 4,920 | Snowy Cabin (scene) | uncommon | |
| 13 | 560 | 5,480 | Knit Scarf (pet, neck) | uncommon | |
| 14 | 560 | 6,040 | Golden Peach (XP food) | rare | |
| 15 | 560 | 6,600 | ★ **Pathfinder's Hat** (pet, head) | rare | new, art |
| 16 | 560 | 7,160 | 250 gold | | |
| 17 | 560 | 7,720 | Frost Rule (top edge) | rare | |
| 18 | 560 | 8,280 | Observatory (scene) | rare | |
| 19 | 560 | 8,840 | Stardust Truffle (XP food) | rare | |
| 20 | 560 | 9,400 | ★ **Summit Banner** (pet, back) | epic | new, art |
| 21 | 560 | 9,960 | 300 gold | | |
| 22 | 560 | 10,520 | Tempered Steel (XP bar) | rare | |
| 23 | 560 | 11,080 | Sky Islands (scene) | epic | |
| 24 | 560 | 11,640 | Honeycomb (XP food) | rare | |
| 25 | 560 | 12,200 | ★ **Switchback Edge** (top edge, loops) | epic | new, a look |
| 26 | 560 | 12,760 | 350 gold | | |
| 27 | 560 | 13,320 | Comet Pendant (pet, neck) | epic | |
| 28 | 560 | 13,880 | Thunder Halo (pet, aura) | epic | |
| 29 | 560 | 14,440 | 400 gold | | |
| 30 | 560 | 15,000 | ★ **Summit at Dawn** (scene, loops) and the **Trailblazer** badge | legendary | new, art |
| 30+ | 1,000 each | | 100 gold | | |

- **The shape:** something every tier; an exclusive every five from tier 10 on, and the first one at 8, so a casual
  player has one in their second week. Gold every fifth tier, rising from 100 to 400 (1,750 in all, about a week's
  gold). XP food every fifth tier, six in all (a 10% boost for 1–3 hours each). Every existing item is common to epic
  and fits the theme: a winter trail, a camp, a summit.
- **No legendary from the drop pool,** so "Legendary find" keeps its meaning. **No sigil,** as above.
- **New and needing work (six items and a badge):**
  - **Art (pixel art, as `starter-scenes.ts` and `starter-wear.ts` draw it, held to `sceneIssue` and the wear checks):**
    - Trailhead, a rare scene: a trail's start in snow, a wooden signpost, a pine.
    - Summit at Dawn, a legendary scene that loops, as the legendary scenes do: a peak at sunrise, a flag, clouds
      drifting below.
    - Pathfinder's Hat, rare, head: a felt hat with a feather.
    - Summit Banner, epic, back: a small pennant on a pole.
  - **A look (glyph data, no pixel art):** Switchback Edge, an epic top edge. `▲` peaks as knots, a dotted trail along
    the line, and stars that twinkle as epic edges do (`twinkle`).
  - **Text only:** the Pioneer title. It is an item of the `title` category in a new `title` slot (see "Engine").
  - **A badge:** Trailblazer (`s1-trailblazer`, epic, 🥾): "Reach tier 30 of Season 1: Trailhead."
- **Exclusive means exclusive, after the season too.** `ItemDef` gains `season: "s1"`. Such an item is in no drop
  pool, no shop shelf, no craft and no re-roll. No quest may name it. Only its own season's tiers grant it, and only
  once, so it can't be a duplicate and is never traded in. `seasonIssue` (beside `catalogIssue` in
  `schema/src/step.ts`) refuses any rules or catalogue that break this, at server start. A later season gets its own
  items, never a recolour of these (Open question 9).
- **Exclusives count toward no badge.** The `owned` and `bandSlots` metrics (`achievements.ts`) skip items with a
  `season`, so no badge's meaning changes. Only Trailblazer reads the season.

## Free vs premium
**Free only in the beta.** There is one track, the same for everyone, and the open source stays free.

A premium track later would need, at least:
- **A payment provider and its webhook** (Stripe, or a merchant of record like Lemon Squeezy, for VAT), with a
  purchase landing as a server-side system event (`pass.bought`). It must never be client-reported, as
  every play event is.
- **A second reward lane per tier** in `Season.pass.tiers`: `premium: SeasonRewards`, granted back to tier 1 on
  purchase.
- **Refunds and chargebacks** that revoke cleanly, which the engine has no notion of today, since a badge is "never
  taken back".
- **Terms of service, a refund policy and a privacy update** (billing data), and an account that can be deleted while
  paid.
- **Online only.** A local server can't verify a purchase, so local play would lose parity for the first time.
- **Cosmetics only:** never XP, sigils or a faster pass, by the same rule that gold never buys XP.

## Engine and replay
### A season as rules data
`schema/src/rules.ts`, new:
```
Season = {
  id: "s1",                          kept for good, like a badge id
  name: "Season 1: Trailhead",
  startsOn: IsoDate,                 a Monday, the first local day
  endsOn: IsoDate,                   a Sunday, the last local day, inclusive
  pass: {
    perDay: Count,                   300: play XP a local day can count
    rested: { perDay: Count, max: Count, start: Count },        150, 600, 600
    missions: Record<MissionCadence, Count>,                    daily 30, weekly 120
    tiers: NonEmptyArray<{ xp: Goal, rewards: SeasonRewards }>, xp is the tier's own cost
    beyond: { xp: Goal, gold: Count },                          1,000, 100
  },
}
SeasonRewards = { gold?: Count, items?: NonEmptyArray<item id> }   at least one key
RulesConfig.seasons: Array<Season>   in date order, never overlapping, ids unique
```
- **Checks in the schema:** `startsOn` is a Monday and `endsOn` a Sunday, after it. Seasons don't overlap.
  `rested.start` and `perDay` are at most `max`.
- **Checks with the catalogue** (`seasonIssue`, at server start, as `catalogIssue` is): every reward item exists and is
  no sigil; an item with `season` set is named only by that season's tiers, once; a badge's `seasonTier` goal is
  at most the season's tier count.
- **Frozen once it starts.** From `startsOn`, a season's entry never changes. A test pins Season 1 to
  `engine/test/fixtures/season-1.json`, as rubric 1's numbers are pinned. One edit is safe: moving `endsOn`
  later before the old end passes, since no event in any log is dated after it yet. The test allows only that.
- **Seasons stay in the rules for good.** Season 2 is appended, so a replay of Season 1's days still finds Season 1.
- **Versions:**
  - **PR 1:** engine 17 (`engine/src/version.ts`), rules 17 with `seasons: []`, rules `schemaVersion` 12. `rules16`
    is kept beside `rules15` as `{ ...starterRules, version: 16, catalogVersion: 8, seasons: [] }`.
  - **PR 2:** rules 18 with Season 1, and catalogue 9 (catalogue 8's items, then the six exclusives at the end).
    `catalog8` is kept as `catalog7` is. Exclusives are filtered out of every pool and sit after catalogue 8's items,
    so a roll over catalogue 9 picks what it would over 8; a test holds the drop pools equal.
  - The starter quest pack stays at 4, and `inputSchemaVersion` stays 1.

### State, events, the step
- **`schema/src/state.ts`:**
  - `Progress.season: NullOr({ id, rested: Count, lastDay: NullOr(IsoDate), days: Array<{ day: IsoDate, play: Count }>
    })` holds the working counters. `days` keeps the last 8 local days, as the edge can still add to the last 7.
  - `Holdings.seasons: Array<{ id, xp: Count, tier: Count }>` is kept for good, as a rebalance keeps holdings. It is
    what the profile and the badge read. A tier's rewards are granted when `tier` passes it, so `tier` is also the
    record of what was granted.
- **`schema/src/primitives.ts`:** `CharacterSlot` gains `title`, and `ItemSource.kind` gains `season`.
- **`schema/src/domain.ts`:**
  - `ItemDef.season: optionalKey(String)`.
  - A title item has `category: "title"` and `slot: "title"`, and has no look or sprite.
  - `Snapshot.season: optionalKey(SeasonView)`, and `Character.title` becomes the equipped title's name, else the
    level's.
- **`schema/src/rules.ts`:** `Metric` gains `{ kind: "seasonTier", season: id }`.
- **`schema/src/server-events.ts`:**
  - `season.started { id, name, endsAt }`: once a season, on the player's first step on one of its days.
  - `season.progress { id, xp, tier, today, cap, rested }`: quiet, after each gain, like `stats.changed`.
  - `season.tier { id, tier, tierLook: Rarity, rewards }`: the banner. `tierLook` is uncommon, epic for an exclusive and
    legendary for tier 30. Items follow as `loot.dropped` (gold 0, pity unchanged, the `season` source), and gold as
    `gold.changed`. Every surface that shows a drop (the inventory's "new", celebrations, the companion's feed)
    works unchanged, and a mod older than PR 3 shows the reward as a drop.
  - `season.ended { id, xp, tier }`: once, on the first step after `endsOn`.
- **`engine/src/season.ts` (new, pure):**
  - `seasonOn(rules, day)`: the season a local day falls in.
  - `gain(run, day, amount)` and `missionBonus(run, cadence, window)`: the formulas above.
  - `tiersReached(season, xp)`.
  - `seasonViewOf(state, rules, now)`: status `upcoming`, `running`, `settling` (7 days after the end) or `over`. It
    also gives `startsAt` and `endsAt` as instants in the player's zone (`startOfDay`), the tier, XP into it, today's
    play against the cap, and the rested pool.
- **`engine/src/step.ts`:**
  - `step` runs `rollSeason` beside `rollQuests` (skipped for bookkeeping, as that is). `rollSeason` starts the
    season's counters (`rested: start`) and emits `season.started` on a step in a new season, and `season.ended` on
    the first step after one.
  - `grant` calls `gain` after it adds the XP, with the day it was granted on. So does `complete`, for a mission's XP
    reward. `complete` adds the mission bonus when the mission's window starts inside the season, so it needs the day
    passed down.
  - Tier rewards are granted by `grantSeason`. It creates entries with `run.newId()`, as a purchase does, and adds the
    gold, and it makes **no roll**.
- **Exclusives out of every pool:** `rollLoot`'s pool (`loot.ts`), `shelfOf` (`shop.ts`), `craft`, `reroll` and
  `rewardDrop`'s named item (`step.ts`). Also the `owned` and `bandSlots` ledger in `achievements.ts`.
- **`engine/src/project.ts`:** the snapshot's `season` and the equipped title. `items` also carries the season's reward
  items, so the mod and the companion can draw the track.

### Replay, before, during and after
- **Before the season** (a day before `startsOn`): `seasonOn` finds nothing, so a step adds no pass XP and emits no
  season event. Every log written before rules 18 replays as it ran: its days are all before 4 January, and nothing
  else changes. The golden fixture (`engine/test/golden.test.ts`) proves it.
- **During:** a gain is a pure function of the state, the day the event counts on (as the caps count it) and the rules.
  A replay feeds the same inputs with the same `now`s, so it lands on the same counters. Rewards make no roll, so a
  replay needs nothing recorded for them. Their entry ids come from `newId()` (the roll seed, the log seq and `now`), so
  they come out the same too.
- **After:** a day after `endsOn` adds nothing. A late event dated inside the season counts on its own day, live and
  in replay alike. After 7 March nothing can be dated inside, so Season 1 is final.
- **Order matters only as it always has:** a late event on an earlier day than `lastDay` adds nothing to the rested
  pool, and counts against that day's own `days` entry.
- **Clock:** the server's `Clock` gives each log row its `now` (`nowIso`), and the engine reads no other time. Server
  tests step a `TestClock` over the start and the end in Pacific/Kiritimati, Europe/London and Pacific/Pago_Pago. The
  mod's `$.clock` only counts down to the `endsAt` the snapshot gives, as it does for missions. It never decides
  whether a day is in.

### Local and online
- **Both get Season 1.** The local server runs `starterRules`, so a player who pulls and restarts after PR 2 gets the
  same dates, pass and rewards. A local save is the player's own, and the exclusivity rule binds the code, not their
  machine.
- **The mod shows the season only when the server's rules have one** (`rules.seasons`). A local server one release
  behind shows nothing and breaks nothing.

### The migration: `0017_seasons` (PR 1)
- It writes `progress.season: null` and `holdings.seasons: []` into every saved state that lacks them, with a
  `jsonb_set` guarded by `IS NULL` and `jsonb_typeof`, like 0006 and 0011.
- Then `UPDATE player_state SET engine_version = 17, rules_version = 17 WHERE engine_version < 17`.
- No log holds a season day before rules 18 names a season, so a replay of any log ends at exactly those values. A test
  holds the two together, on PGlite and Postgres, and migrating twice equals once.
- It makes the deploy one-way, as 0015 did: an old image answers 503 `ServerBehind`. Roll forward, or restore R2's
  backup (docs/deploy.md).
- Rules 18 (PR 2) needs no migration, as rules 15 and 16 needed none.

## Surfaces
### The band and the status line: one compact element
After the "too much to bear" feedback the band folds away by default, and the season must not undo that.
- **No new band row, and nothing permanent on the band.** In `full`, the top edge carries `S1 12/30` near its right
  end, in the edge's own colours (`band.ts` `edgeRow`), on the row it already draws.
- **The status line gains one part, last:** `⚔ Lv 7 ▰▰▰▱▱ 340/500 xp · 2 missions · last prompt 8.2 · S1 12/30`, with
  a new `season` role in `status.ts`. Being last, it is the first part to go on a narrow row, so it never pushes out
  what is there today. It shows only while a season runs.
- **Moments, which open the auto band and close as any moment does:**
  - `season.started`: once, an epic-tier celebration, "Season 1: Trailhead has begun".
  - `season.tier`: the tier and its reward, at the tier's look. A regular player sees about one a day.
  - `season.ended`: once, with the final tier.
  - Tiers reached together, as after a big day, play as one moment that names the highest tier.
- **The title:** an equipped Pioneer replaces the level's title in `levelRow` ("Lv 12 Pioneer"). The snapshot already
  gives the title, so `band.ts` doesn't change.

### The pane: a Season tab
A sixth tab, after Missions: `{ id: 'season', label: 'Season', short: 'Season', tiny: 'S1' }` in `pane.ts`. It is
ready while a season is upcoming, running or settling, and dim otherwise.
```
 Season 1: Trailhead · ends Sun 28 Feb (31 days)                      tier 12 of 30
 ▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱   240/560 to tier 13
 Today 180/300 from play · rested 300: what you earn counts double · missions +30 daily, +120 weekly
 Next  13 Knit Scarf · 14 Golden Peach · 15 ★ Pathfinder's Hat (Season 1 only)
 ✓ 1 100 gold   ✓ 2 Sugar Plum   ✓ 3 Kite Hill   …   ✓ 8 ★ Trailhead   ✓ 10 ★ Pioneer   ·  12 Snowy Cabin …
```
The track lists all 30 tiers and wraps to the pane's width. The exclusives draw in their rarity's colour with ★, and the
scenes and the wear preview on focus, as the Shop tab previews styles. Upcoming, the tab shows the dates, the rules in
three lines and the track. Over, it shows the final tier and what was earned.

### The welcome and the update notice
- **New players:** the welcome (`welcome.ts`) gains one line on its last step while a season runs: "Season 1 is on:
  everything you earn fills the pass. See the Season tab."
- **Existing players:**
  - PR 3's version bump makes the online server's update notice (`update.ts`) say once that a newer mod is out, so it
    ships by 21 December. Both daily players then update before the start.
  - On the day, `season.started` is their welcome.
  - A mod older than PR 3 still earns the pass, server side, and shows its rewards as drops.

### The profile
- **A `season` section** in `profileSections`, shown by default, after `badges`. It shows only the season's name, the
  tier of 30 and the exclusives owned: "Season 1: Trailhead · tier 24 of 30". It shows no pass XP and no per-day data.
  Ended seasons stay listed.
- **The header** shows the equipped title, as the band does.
- Files: `server/src/profile.ts` (the view), `server/src/pages.ts` (the card), `schema/src/profile.ts`. Also
  `docs/privacy.md` and `site/privacy/`: what the section shows.

### The site: the Season 1 page, for the LinkedIn link
**`https://pathof.dev/season-1/`** (`site/season-1/index.html`), kept after the season as its record:
- The hero, "Season 1: Trailhead, 4 January to 28 February 2027", with "started" or a countdown in the reader's zone.
  It is one small script, hashed for the CSP by `pnpm site`.
- **How the pass fills,** in four lines. The numbers are marked `data-rule="seasons/0/pass/perDay"` and so on, and
  `site-pages.test.ts` reads them back against the rules.
- **The track:** the 30 tiers, with the six exclusives drawn large. Their art is rendered to PNGs from the catalogue's
  art by `pnpm site`, and a test checks each PNG's hash against the art it was made from.
- **"Do I lose my level?" No:** the carry-over rules in three bullets, and a pointer to /start/.
- Its own preview card, `site/season-1/og.png`, rendered from `docs/og-season-1.html` as the home card is.
- The header nav gets "Season 1" while the season runs (the test needs each page reachable from the nav), and a
  changelog entry and two FAQ entries go in.

### The companion (later)
Home's status block gains `S1 tier 12/30 · 180/300 today`, from the snapshot's `season`. PR 1 adds `season` to
`contract/snapshot.json` and lists its fields in `contract/unread.txt`, so the `rust` job stays green until the
companion reads them.

## Season leaderboard
**Not in Season 1. Later, as an opt-in, and not before 20 players play a season.**
- **With 4 players** a ranking just names the two daily players, and it tells strangers how few play.
- **The pass measures days, not skill.** The cap makes everyone who plays daily tie at the top, so a ranking by tier
  would rank by time zone and by who started first.
- **Reported tier:** a leaderboard would turn a forged event into status. Today forging buys only a cosmetic.
- **When it comes, the privacy rules:**
  - Only public profiles (`privacy.public`) whose `season` section is shown. Even then, only a player who opts in to a
    new `leaderboard` section, which starts hidden as `history` does. A public page is not consent to be ranked.
  - It shows only the login (the page's link), the character name and the tier. No XP, no days and no times.
  - It is served by the public server beside `/u/*`, under the same rate limit.
  - A player who goes private or deletes the account leaves it at once, as the profile does.
- **Meanwhile there are no public counts either:** the Season 1 page shows no "N players joined" while N could point
  at a person. The owner watches the counts in `/pathofdev admin stats` (later, below).

## Tests
- **Engine properties:**
  - A day's play never counts past `perDay`, plus the rested pool's double.
  - Pass XP never falls.
  - Each tier's rewards are granted exactly once.
  - A day outside the season adds nothing.
  - Rested never grows on a day with pass XP, and never past `max`.
  - Dev XP and `xp.carried` add nothing.
- **Replay:**
  - A seeded log that spans the start, the season, the end and the 7 days after it gives the same state live and in
    replay.
  - The golden fixture from before PR 1 replays unchanged.
- **Pools:** no exclusive is ever dropped, shelved, crafted, re-rolled or named by a quest, over many seeds. Catalogue
  9's drop pools equal catalogue 8's.
- **`seasonIssue`:** it refuses an exclusive named by two seasons or by a quest, a sigil reward, an overlap, and a start
  that isn't a Monday.
- **Freeze:** Season 1 equals `fixtures/season-1.json` in every field but a later `endsOn`.
- **Pacing:** `season-pacing.test.ts` plays the three players (and the weekly and late ones) through `step` under a
  stepped clock. It holds casual at tier 25–27, regular finished by day 45 and heavy no earlier than day 30.
- **Server, on PGlite and Postgres:**
  - `0017` on a save from main's engine.
  - The season's start and end over a `TestClock` in the three zones.
  - Late events from an offline queue during the settle week.
  - The snapshot's `season` across `upcoming`, `running`, `settling` and `over`.
- **Mod:**
  - The status line's part is last and drops first.
  - The tab across the four statuses, at 40, 80 and 120 columns.
  - Tiers reached together play one moment.
  - Glue in `pathofdev.test.ts` against `fakeServer`, with and without `rules.seasons`.
  - A stream with `season.*` events in it, read by mod 0.14.0's reader, draws as before.
- **Site:** the page is in `site-pages.test.ts`'s list, its `data-rule` numbers match, and its PNGs match the art.

## Launch checklist
**Day one (Monday 4 January) needs:**
- [ ] PR 1 deployed by 14 December, and PR 2 by 21 December (the season shows as upcoming).
- [ ] PR 3 (the mod) released by 21 December. Both daily players are on it.
- [ ] PR 4 (profile) and PR 5 (site page) live by 28 December. The page says "starts Monday 4 January".
- [ ] A dry run of the whole season: a local server with Season 1's dates moved to today in an uncommitted copy. It
      covers install, login, first prompt, tier 2, a tier with an exclusive, the end and the settle.
- [ ] A fresh GitHub account goes through /start/ end to end against the online server: marketplace install,
      `/pathofdev login`, a graded prompt, the pass moving.
- [ ] The restore drill (`restore-drill.yml`) green in the last week, and R2's backup fresh.
- [ ] Signup open (`SIGNUP` not `allowlist`), and the rate limits checked for a burst of new players (docs/deploy.md).
- [ ] LinkedIn's Post Inspector shows the Season 1 card. The post goes out after 12:00 UTC on 4 January, linking
      `https://pathof.dev/season-1/`.
- [ ] On the day, the owner watches `/pathofdev admin stats` for signups and players.

**Later:**
- Season counts in `/pathofdev admin stats`, for the admins only (week 1).
- The companion's season line.
- A recap on the Season 1 page after the settle (from 8 March), with aggregates only once 20 or more played.
- Season 2's plan by mid-February: seasonal quests, and the leaderboard if the numbers allow.

## PR breakdown (in order)
0. **This plan.**
1. **PR 1: seasons in the engine, with none in the rules** (schema, engine, server).
   - `Season`, `seasons: []`, `ItemDef.season`, the `title` slot, the `season` source, the `seasonTier` metric,
     `Progress.season`, `Holdings.seasons` and the four events.
   - `engine/src/season.ts`, `rollSeason`, the hooks in `grant` and `complete`, the grants, exclusives out of every
     pool, and the snapshot's `season` and title.
   - `seasonIssue` in `game.ts`, `0017_seasons`, engine 17 and rules 17, `rules16` kept, the contract fixture and
     `unread.txt`.
   - It is tested with a test-only season. No player sees a change. It is deployed online, and touches no mod hook.
2. **PR 2: Season 1's content.**
   - Catalogue 9: the six exclusives, with the art of the two scenes and the two pieces of wear, the edge's look and the
     title. `catalog8` kept.
   - The Trailblazer badge, rules 18 with Season 1 (dates, pass, 30 tiers), `fixtures/season-1.json` and the pacing
     test.
   - Deployed online. The season shows as upcoming in the snapshot.
3. **PR 3: the mod** (0.15.0): the status line's part and the edge's label, the Season tab, the three moments and
   the tier banner, the title in the level display, the welcome's line, the README and `plugin.json`.
4. **PR 4: the profile:** the `season` section and card, the title in the header, `docs/privacy.md` and
   `site/privacy/`.
5. **PR 5: the site:** `site/season-1/` with its script, PNGs and card, `docs/og-season-1.html`, the nav link, the
   changelog and the FAQ, and `site-pages.test.ts`.
6. **Later:** admin season counts; the companion's line; the recap; Season 2.

PR 1 touches `migrations.ts` and PR 2 the catalogue. Both touch `starter.ts`, so they land in order.
PRs 3–5 depend only on PR 2's rules, and can be reviewed in parallel.

## Open questions (for the owner)
1. **When does Season 1 start?**
   - **Recommendation: Monday 4 January 2027,** to Sunday 28 February. That gives eight weeks to build and settle, no
     December holidays inside the first season's numbers, and a New Year post. The alternative is 7 December to
     31 January.
2. **Eight weeks?**
   - **Recommendation: yes.** Casual reaches tier 26 and regular finishes in week 7. Six weeks leaves casual near tier
     21, and twelve leaves the daily players coasting for seven weeks.
3. **Is 300 pass XP a day from play the right cap?**
   - **Recommendation: 300,** with the tier costs above. It sits above a casual day (about 256), so casual play counts
     in full, and below a regular day (about 500), so hours past it earn nothing on the pass. Tune only before the
     start. From 4 January it is frozen.
4. **Does everyone start rested (600)?**
   - **Recommendation: yes.** The first day then gives tier 2 or 3, and a late joiner starts on the same footing as
     everyone did on day one.
5. **Add an equippable `title` slot for Pioneer?**
   - **Recommendation: yes.** The category already exists, and a title is the cheapest exclusive to make (no art) and
     the most visible one (band and profile). It shows the title text only. The level's glyph and number stay.
6. **The badge at tier 30, or for taking part?**
   - **Recommendation: tier 30 (Trailblazer).** Taking part already shows on the profile's season card. A badge for
     finishing keeps badges about doing something.
7. **A Season tab, or a section of Missions?**
   - **Recommendation: its own tab, after Missions.** The track needs the room, and Missions is already full on a
     narrow pane. The tab is dim between seasons.
8. **A leaderboard?**
   - **Recommendation: not in Season 1.** Later, as an opt-in, once 20 or more play a season, with the rules in
     "Season leaderboard".
9. **May a later season bring back an exclusive, recoloured?**
   - **Recommendation: no.** Each season makes its own items, and a recolour of a Season 1 item would read as the same
     item to a stranger. `seasonIssue` checks ids, and review checks the art.
10. **Gold past tier 30?**
    - **Recommendation: yes, 100 per 1,000 pass XP.** It gives the daily players a reason to keep playing the season
      out, in a currency that never buys XP. At their pace that is about 300 gold a week, or a day and a bit of gold.
11. **The name "Season 1: Trailhead", and the URL `/season-1/`?**
    - **Recommendation: yes.** The path's first stretch, for the game's first season. The URL stays as the season's
      record after it ends.
