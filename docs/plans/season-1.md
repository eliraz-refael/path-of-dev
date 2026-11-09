# Plan: Season 1, the opening season, and the devpass (2026-11-09, revised 2026-11-09)

Planned against main at 38151e8 (#71: engine 16, rules 16, catalogue 8 of 194 items, mod 0.14.0, migrations up to
0016). File references are as of that commit. The numbers below come from `starter.ts` and `starter-quests.ts`, not
from play data: with four players there is not enough of it to tune on.

Revised after the owner's decisions and the plan review:
- The season starts on Thursday 26 November.
- What must ship by then is a small kernel.
- The art, the badge, the profile and the bigger moments land during the season.

## Goal
Give the game a public start: **Season 1**, 60 days with a start and an end, and a **devpass** (a battle pass) that
ordinary play fills. Strangers who hear of it get a reason to join now: a fair start on the pass whatever their level,
and rewards that exist only this season. Players get a goal they can see every day: today's pass XP against the day's
cap, and the next tier.

The core loop stays as it is. The season is a second, short track beside the level, and it never changes what play
earns.

## Non-goals
- **Payments.** The beta is free and open source (see "Free vs premium").
- **A leaderboard** (see "Season leaderboard").
- **New mission kinds.** The season's missions are the existing dailies and weeklies. Seasonal quests wait for Season 2.
- **A title slot.** It is cut for Season 1. The Trailblazer badge is the season's mark on the profile.
- **Resetting anything players own or have earned:** levels, XP, inventory, gold, badges, streaks.
- **A heavier band:** no new row, and no permanent element (see "Surfaces").
- **A migration.** Every new field is an optional key, so no saved state needs rewriting (see "Engine").

## Facts found in the code (they drive the design)
- **The engine's only clock is the log row's receipt time** (`Context.now`, `schema/src/step.ts`), set from Effect's
  `Clock` (`server/src/game.ts` `nowIso`). Days are local days in the player's zone (`engine/src/days.ts`), and caps,
  streaks and missions all count by them.
- **A client event counts on its own local day,** held to today at most (`step.ts` `applyClient`). The edge rejects
  events more than 7 days old (`server/src/edge.ts` `maxAge`). `prune` (`step.ts`) keeps `progress.tallies` and
  `activeDays` from 7 days back, and `activeDays` further while a streak runs.
- **`DayTally`** (`schema/src/state.ts`) is `{ day, counts }` per local day: the place a day's own counters live.
- **Rules are retroactive** (`appliesFrom: null`), and the server runs every input under one rules config
  (`game.ts`). A number that must replay as it was priced is frozen, as rubric 1's are. Old catalogues are kept as data
  (`catalog6`, `catalog7`), because **a roll picks an item by its place in the pool**.
- **`rewardDrop`** (`step.ts`) lands a named item through a roll of chance 1, recorded for replay. It refuses a
  sigil. **An item the catalogue lacks rolls from the pool instead**, so the season must check that an item is there
  before it names it.
- **In a replay, a roll the log has no record of returns nothing** (`step.ts` `roll`: "only the recorded rolls replay").
- **XP rates** (`starterRules`): a v2 prompt pays `15 × grade / 10`. The first 20 of a day pay in full, the next 20
  half, then 10%, all times the sigil (×1.2–2.5). The streak pays 10 a day, up to 70. Commits pay 3 (20 a day),
  green tests 20 (5 a day), explored repos 25 (3 a day). Merges pay 250, or 120 in one's own repo, and are
  **uncapped**. Dailies pay 30–60, weeklies 120–300. The grading experiment's mean v2 grade (7.31) makes a typical
  prompt about 11 XP.
- **Gold:** a steady day earns about 240, and gold never buys XP (`engine/src/shop.ts` `buysXp`).
- **Drop, shelf, craft and re-roll pools** each filter the catalogue on their own: `loot.ts` `rollLoot`, `shop.ts`
  `shelfOf`, and `craft`, `reroll` and `rewardDrop` in `step.ts`.
- **The band folds away by default** (`mod/hooks/collapse.ts`, `band: auto` since #49). The status line carries the
  essentials, and drops its parts from the right on a narrow row (`mod/hooks/status.ts`).
- **The pane has five tabs** (`mod/hooks/pane.ts` `tabs`).
- **Profile sections** have defaults (`schema/src/profile.ts`).
- **The site is static HTML,** checked by `engine/test/site-pages.test.ts`.
- **The companion's contract** fails CI when a snapshot field is added and not listed (`contract/unread.txt`).
- **The LinkedIn post got impressions and no installs,** so install has to work for a stranger before a season can
  help.

## Decisions
1. **Season 1: Trailhead** runs from **Thursday 26 November 2026 to Sunday 24 January 2027**: 60 local days in each
   player's zone. The owner picked Thursday, as it is not a Friday or Saturday in Israel. Week 1 is short (Thursday
   to Sunday), then come eight full weeks.
2. **Levels, XP, inventory, gold, badges and the streak carry over.** Only the pass resets.
3. **30 tiers** for 18,000 pass XP: tiers 1–5 cost 200 each, and tiers 6–30 cost 680 each. Past tier 30, every 1,000
   pays 100 gold.
4. **The pass fills from both:** play XP counts up to **300 a local day**, and each mission completed on a season day
   adds **+30 for a daily or +120 for a weekly**, on top of the cap.
5. **Rested is derived, not stored:** a played day counts double (cap included) when the day before it had no play,
   and so does the season's first day.
6. **Rewards land on reaching a tier,** through `rewardDrop`. Five items are exclusive to Season 1, and the Trailblazer
   badge goes with tier 30. The exclusives land during the season, granted retroactively.
7. **Free only:** one track for everyone.
8. **A season is rules data,** frozen once it starts. The kernel stores one record per season, `{ id, xp, tier }`, and
   one field on `DayTally`.
9. **Local players get the same season,** from the same rules.
10. **Step 0 comes first:** the stranger test of install, before any season PR.

## Season shape
**Dates: Thursday 26 November 2026 to Sunday 24 January 2027, 60 days.**
- **Week 1 is short:** Thursday 26 to Sunday 29 November. It sits inside the weekly window that began Monday
  23 November. Then come eight full weeks, Monday 30 November to Sunday 24 January.
- **A season can start on any weekday.** Only the dates count, and the missions keep their own windows.
- **The December holidays fall inside.** Doubling after a day off softens a missed week, and the tier costs leave a
  regular player a week to spare.
- **US Thanksgiving is 26 November.** That is a timing caveat for the announcement, not a reason to move (Open
  question 7).

**Time zones: local days, like everything else.**
- The season covers the local days `startsOn` to `endsOn` in each player's zone, so it begins at their own midnight,
  as a daily does. It matches the caps, the streak and the missions.
- The start spreads over about 25 hours. Kiritimati (UTC+14) starts at 10:00 UTC on Wednesday 25 November, and Pago Pago
  (UTC−11) at 11:00 UTC on Thursday 26 November. **Announce after 12:00 UTC on the 26th** (14:00 in Israel), when it has
  begun everywhere people live.
- `timezone.changed` can move a player's day by about a day, as it can for the caps today. That gains at most one
  day's cap, and only once.

**The end.**
- A local day after `endsOn` earns no pass XP. Play dated inside the season still counts when it arrives late (an
  offline queue), until the edge's 7-day limit. So the season **settles on Sunday 31 January 2027**, and nothing
  changes it after that.
- There is nothing to claim. Rewards land as tiers are reached, so nothing is lost at the end.
- Afterwards the status line's part goes. The Season tab and the profile keep the final tier.

**What carries over, and why.**
- **Levels and XP carry over.** The level curve is tuned for a long climb: Legend, level 100, is 208,900 XP, about a
  year of steady play. A reset would take that from the two daily players, the game's core, and would make early
  levels trivial while their sigils still apply. Fairness to newcomers lives on the pass, where everyone starts at 0.
- **Inventory and gold carry over:** "An item is never taken out" (`starter.ts`).
- **Badges carry over:** they are kept for good once earned (`achievements.ts`).
- **The streak carries over.** It measures a habit, not a season.
- **One continuous state.** Replay runs the whole log through one state. A reset would need a season boundary inside
  replay. Carrying over needs nothing.
- **What resets:** the pass's XP and tier, per season. Each season's `{ id, xp, tier }` is kept for good.

## The devpass
### What fills the pass
```
on an XP grant of `amount` on season day d (any reason but dev; never xp.carried):
  tally[d].pass = min(perDay, tally[d].pass + amount)                         300 a local day
value(d)    = tally[d].pass × (rested(d) ? 2 : 1)
rested(d)   = d = startsOn  or  d − 1 is not in activeDays                    a pure function of the days played
on a mission completed on season day d:  bonus += missions[cadence]           daily 30, weekly 120
pass XP     = Σ value(d) over the season's days  +  the bonuses
```
- **Every XP counts the same:** prompts, work, the streak and mission rewards, after the sigil and boosts, as the bar
  shows it. The player reads: "everything you earn fills the pass too, up to 300 a day, and double after a day off".
- **The cap keeps it fair.** A regular day (about 500 XP) and a heavy one (about 1,700, merges included) both count
  300. So the pass rewards days played and missions done, not hours.
- **The mission bonus counts by the day the mission completes,** whatever day its window began. So a weekly picked on
  Monday 23 November and finished on the 27th counts. Each mission completes once per window (`completedQuests`), so
  the bonus can't be farmed.
- **Rested is the catch-up.**
  - It doubles real play and adds nothing alone, so not playing never earns.
  - It reads only the days played, so it is a pure function of `activeDays`.
  - A late event that fills a rest day takes the double off the day after: that day was not after a day off.
  - The season's first day doubles for everyone, and so does a stranger's first day at any point, since they had no
    play the day before.
- **One rule, not a pool.** "Double after a day off" needs no stored, spent balance. It has no k: a longer gap gives no
  more than a one-day gap. That keeps a week off from paying a week's worth, and keeps the rule one sentence long.

### Tiers
30 tiers, each with its cost in rules data: **200 for tiers 1–5** (1,000 in all) and **680 for tiers 6–30**
(17,000). The total is **18,000**.
- The first day gives a casual player tier 2 and a regular one tier 3, so a stranger sees the pass move within the hour.
- **Past tier 30, every 1,000 pass XP pays 100 gold,** so the daily players keep a reason to play the season out.

### Pacing
These are assumptions from the rules as they stand: a prompt about 11 XP, with the taper and the caps. The pacing test
(PR 1) plays these players through `step` and pins the results.

| | casual | regular | heavy |
|---|---|---|---|
| days played | 3 a week, never two in a row (26) | Mon–Fri (42) | every day (60) |
| XP earned a day played | ~256: 15 prompts 164, streak ~15, commits 12, a green run 20, a daily ~45 | ~500: 30 prompts 274, streak, commits, tests, explore, two dailies | ~1,700: 50 prompts, the fact caps, merges, three dailies |
| value a day played | 512: every day follows a day off | 600 on the first day and Mondays, else 300 | 600 on 26 Nov, then 300 |
| mission bonus | a daily a day (+30), a weekly a week (+120) | two dailies (+60), two weeklies (+240) | three dailies (+90), three weeklies (+360) |
| pass XP a full week | ~1,830 | ~2,340 | ~3,090 |
| first day, 26 Nov | 542 → tier 2 | 660 → tier 3 | 690 → tier 3 |
| tier 8 (the first exclusive) | Mon 7 Dec (day 12) | Thu 3 Dec (day 8) | Tue 1 Dec (day 6) |
| **at the end** | **~15,800: tier 26 of 30** | **finishes Mon 18 Jan (day 54)**, 19,860 in all | **finishes Mon 4 Jan (day 40)**, ~26,900, 8 gold tiers |

- **Casual gets most of it:** tier 26, with four of the five exclusives (all but the tier 30 scene). Doubling gives
  about 6,700 of their 15,800, close to the old pool's share.
- **A regular player finishes** with six days to spare.
- **Other players:**
  - Playing **one day a week** (9 days) gives about 4,900, tier 10, the Trailhead scene included.
  - A **regular who starts on Monday 21 December** gets about 11,700, tier 20, with three exclusives. Joining early
    pays, which is the point of announcing it.
  - **No one finishes before about day 40,** even with forged events: each day holds to 600 at most, plus the missions,
    which pay once per window.

### Anti-farm, consistent with the rules
- **The daily cap** counts by the local day the fact caps use, so an uncapped fact (a merge, prompts past the taper)
  still counts 300 at most.
- **Rested only multiplies real play.** It comes from a day without play, so playing less never earns more.
- **Mission bonuses** come once per mission per window, as their rewards do.
- **Dev XP and `xp.carried` never count.**
- **No reward is an XP edge:** no sigil at any tier, as `rewardDrop` refuses one. The gold buys no XP.
- **Reported tier:** a modified mod can forge events, and so the pass. Its rewards are cosmetic, and the cap holds a
  forger to a daily player's pace. That is also why the pass gets no leaderboard.

## Rewards
Every reward is named in rules data. Gold lands as `gold.changed` (reason `season`). Items land through `rewardDrop`,
named, with the source `{ kind: "season", ref: "s1/<tier>" }`. Like a quest's drop, a season drop moves the pity
timers. A reward the player already owns is a duplicate, and trades in like any other. ★ marks the exclusives, which
land during the season (see "The exclusives").

| tier | cost | total | reward | rarity | lands |
|---|---|---|---|---|---|
| 1 | 200 | 200 | 100 gold | | 26 Nov |
| 2 | 200 | 400 | Sugar Plum (treat) | uncommon | 26 Nov |
| 3 | 200 | 600 | Kite Hill (scene) | common | 26 Nov |
| 4 | 200 | 800 | Trail Mix (XP food) | common | 26 Nov |
| 5 | 200 | 1,000 | Rope Rule (top edge) | common | 26 Nov |
| 6 | 680 | 1,680 | 150 gold | | 26 Nov |
| 7 | 680 | 2,360 | Trail Pack (pet, back) | uncommon | 26 Nov |
| 8 | 680 | 3,040 | ★ **Trailhead** (scene) | rare | PR 4, by 3 Dec |
| 9 | 680 | 3,720 | Matcha Latte (XP food) | uncommon | 26 Nov |
| 10 | 680 | 4,400 | Brass Lantern (pet, hand) | rare | 26 Nov |
| 11 | 680 | 5,080 | 200 gold | | 26 Nov |
| 12 | 680 | 5,760 | Snowy Cabin (scene) | uncommon | 26 Nov |
| 13 | 680 | 6,440 | Knit Scarf (pet, neck) | uncommon | 26 Nov |
| 14 | 680 | 7,120 | Golden Peach (XP food) | rare | 26 Nov |
| 15 | 680 | 7,800 | ★ **Pathfinder's Hat** (pet, head) | rare | PR 5, by 17 Dec |
| 16 | 680 | 8,480 | 250 gold | | 26 Nov |
| 17 | 680 | 9,160 | Frost Rule (top edge) | rare | 26 Nov |
| 18 | 680 | 9,840 | Observatory (scene) | rare | 26 Nov |
| 19 | 680 | 10,520 | Stardust Truffle (XP food) | rare | 26 Nov |
| 20 | 680 | 11,200 | ★ **Summit Banner** (pet, back) | epic | PR 5 |
| 21 | 680 | 11,880 | 300 gold | | 26 Nov |
| 22 | 680 | 12,560 | Tempered Steel (XP bar) | rare | 26 Nov |
| 23 | 680 | 13,240 | Sky Islands (scene) | epic | 26 Nov |
| 24 | 680 | 13,920 | Honeycomb (XP food) | rare | 26 Nov |
| 25 | 680 | 14,600 | ★ **Switchback Edge** (top edge, loops) | epic | PR 5 |
| 26 | 680 | 15,280 | 350 gold | | 26 Nov |
| 27 | 680 | 15,960 | Comet Pendant (pet, neck) | epic | 26 Nov |
| 28 | 680 | 16,640 | Thunder Halo (pet, aura) | epic | 26 Nov |
| 29 | 680 | 17,320 | 400 gold | | 26 Nov |
| 30 | 680 | 18,000 | ★ **Summit at Dawn** (scene, loops) and the **Trailblazer** badge | legendary | PR 5 |
| 30+ | 1,000 each | | 100 gold | | 26 Nov |

- **The shape:**
  - Something at every tier.
  - An exclusive every five tiers from 15, and the first at tier 8.
  - Gold every fifth tier, from 100 to 400: 1,750 in all, about a week's gold.
  - XP food every fifth tier, five in all.
  - Every existing item is common to epic, and fits a winter trail.
- **No legendary from the drop pool**, so "Legendary find" keeps its meaning. **No sigil.**
- **New, with their work:**
  - **Pixel art,** held to `sceneIssue` and the wear checks:
    - Trailhead, a rare scene: a trail's start in snow, a signpost, a pine.
    - Summit at Dawn, a legendary scene that loops: a peak at sunrise, a flag, clouds drifting.
    - Pathfinder's Hat, rare, head: a felt hat with a feather.
    - Summit Banner, epic, back: a pennant on a pole.
  - **A look** (glyphs, no pixel art): Switchback Edge, an epic top edge with `▲` knots, a dotted trail and stars that
    twinkle (`twinkle`).
  - **The badge:** Trailblazer (`s1-trailblazer`, epic, 🥾): "Reach tier 30 of Season 1: Trailhead."

### The exclusives, landing during the season
- **In rules data from the start.** A tier names its exclusive in its own field, `exclusive: "trailhead"`, apart from
  the `items` that must already be in the catalogue. The kernel's rules name all five. The catalogue gets each item
  when its art lands: catalogue 9 (PR 4), then 10 (PR 5).
- **Until then the tier grants nothing for it.** The Season tab says "Trailhead arrives in early December, and comes to
  you if you are past tier 8". An exclusive the catalogue lacks is never handed to `rewardDrop`, which would roll a
  stand-in from the pool.
- **Granted retroactively:**
  - At the end of every step, each exclusive whose tier is at or below the player's `tier`, and that the catalogue now
    holds, is granted through `rewardDrop` if no inventory entry of it exists yet.
  - Exclusives come only from here, once each, and can't be traded in (`tradeRefusal` refuses an item with a `season`).
    So "an entry exists" is a stable record, and needs no stored list.
  - A player already past tier 15 when PR 5 deploys gets the hat on their next prompt.
- **Replay-safe:**
  - The grant is a roll, recorded with its step, and always the step's last roll.
  - In a replay under the later catalogue, the steps before the deploy try it too. The log holds no roll at that place
    for them, so `roll` returns nothing and nothing is granted. Being last, the try shifts no other roll.
  - The step that granted it live finds its recorded roll and grants the same entry. A replay therefore ends in the live
    run's state, and a test replays a log across PR 4's deploy to prove it.
- **The badge unlocks the same way.** `unlockAchievements` runs after every step, so a player who reached tier 30
  before PR 5 unlocks Trailblazer on their next step.
- **Exclusive for good:**
  - `ItemDef` gains `season: "s1"`, and such items are out of the one derived pool (see "Engine").
  - No quest may name one, and the `owned` and `bandSlots` badge metrics skip them, so no badge's meaning changes.
  - `seasonIssue` (beside `catalogIssue` in `schema/src/step.ts`) refuses any rules or catalogue that hands one out
    elsewhere, at server start. A later season makes its own items, never a recolour of these.

## Free vs premium
**Free only in the beta:** one track, the same for everyone.

A premium track later would need, at least:
- **A payment provider and its webhook** (Stripe, or a merchant of record like Lemon Squeezy, for VAT). The purchase
  lands as a server-side system event. It must never be client-reported, as every play event is.
- **A second reward lane per tier,** granted back to tier 1 on purchase.
- **Refunds and chargebacks** that revoke cleanly. The engine has no notion of this today: a badge is "never taken
  back".
- **Terms of service, a refund policy and a privacy update** for billing data.
- **Online only:** a local server can't verify a purchase, which ends parity with local play.
- **Cosmetics only:** never XP, sigils or a faster pass.

## Engine and replay
### The kernel (PR 1): Season 1 as rules data, one record, one field
`schema/src/rules.ts`:
```
Season = {
  id: "s1",                                 kept for good, like a badge id
  name: "Season 1: Trailhead",
  startsOn: IsoDate, endsOn: IsoDate,       the first and last local days, inclusive
  pass: {
    perDay: Count,                          300
    rested: { factor: Count },              2: a played day after a day off, and the first day
    missions: Record<MissionCadence, Count>,             daily 30, weekly 120
    tiers: NonEmptyArray<{ xp: Goal, gold?: Count, items?: NonEmptyArray<id>, exclusive?: id }>,
    beyond: { xp: Goal, gold: Count },      1,000, 100
  },
}
RulesConfig.seasons: Array<Season>          in date order, never overlapping, ids unique
```
- **Checks:**
  - In the schema: `endsOn` after `startsOn`, no overlap, and each tier names a reward.
  - `seasonIssue`, with the catalogue at server start: every `items` id exists and is no sigil. An `exclusive` id, once
    the catalogue has it, is marked with this season and named by no other tier. A test lists the five expected
    exclusive ids, so a typo fails CI and does not silently grant nothing.
- **State:**
  - `DayTally` gains `pass: optionalKey(Count)`: the play XP that day counted toward the pass, at most `perDay`. It is
    the same per-day record the fact caps use, so there is no new list.
  - `Holdings` gains `seasons: optionalKey(Array<{ id, xp: Count, tier: Count }>)`. This is the one stored pass counter
    and the tier reached, kept for good. Absent reads as none.
- **The counter stays equal to the formula.** Each step adds to `xp`:
  - first, the change in `Σ value(d)` over the days the tallies keep, after the step minus before it;
  - then the step's mission bonuses.

  Days older than the tallies can no longer change, so their value is already in `xp`. `prune` keeps `activeDays` one
  day further back than the tallies, so the oldest tally's look-back day is always there. So `xp` is always
  `Σ value(d) + bonuses`, whatever order the events came in.
- **Tiers:** `tier` is the highest tier reached and never falls. When a step lifts it, each new tier's gold and items
  are granted then: gold first, then `rewardDrop` for each named item, with the season source. A late event that removes
  a day's double can lower `xp` by at most one day's value, but takes no tier or reward back.
- **The step (`engine/src/step.ts`, with `engine/src/season.ts` new and pure):**
  - `grant` adds to `tally[d].pass` on a season day. So does `complete`, for a mission's XP, which also adds its
    bonus. `complete` gets the day passed down.
  - `markActive` changes `activeDays`, which the next recount reads.
  - The recount and the tier grants run after dispatch, the rolls last. `season.ts` holds `seasonOn(rules, day)`,
    `valueOf`, `recount` and `tiersReached`.
- **Events:** only `season.tier { id, tier, rewards }`, the banner. The rewards' own `loot.dropped` and `gold.changed`
  follow, as a quest's do. **There is no `season.progress`:** the snapshot carries the season's state.
- **The snapshot** (`engine/src/project.ts`): `season: optionalKey(SeasonView)`:
  `{ id, name, status: upcoming | running | settling | over, startsAt, endsAt, xp, tier, tiers, intoTier, forTier,
  today: { pass, cap, doubled } }`. The instants are the player's local midnights (`startOfDay`). `items` also carries
  the tiers' reward items, so the tab can draw them. `contract/snapshot.json` and `unread.txt` gain it.
- **Versions:**
  - Engine 17 and rules 17 (Season 1 in it), with rules `schemaVersion` 12. `rules16` is kept as
    `{ ...starterRules, version: 16, catalogVersion: 8, seasons: [] }`.
  - The catalogue stays 8.
- **No migration:** the new keys are optional, and engine 16 also shipped without one. The deploy is still one-way, as
  any engine bump is: an old image answers 503 `ServerBehind`.
- **Frozen once it starts.** From 26 November, Season 1's entry is pinned to `engine/test/fixtures/season-1.json`. One
  edit is allowed: moving `endsOn` later before the old end passes, since no log holds a day after it yet.

### After the start (PRs 4–5): the exclusives and one derived pool
- **One pool:** `engine/src/pool.ts` `dealableOf(catalog)`, memoised per catalogue. It is the catalogue without
  `season` items, and the one list that `rollLoot`'s default pool, `shelfOf`, `craft`, `reroll` and the quests'
  `rewardDrop` all take. Only the season's grant names from the full catalogue. A test fails if any other module
  filters on `season`.
- **Catalogue 9** (rules 18) adds Trailhead, and keeps `catalog8`. **Catalogue 10** (rules 19) adds the other four and
  the badge. Each appends its items after the last, and the pool excludes them, so the drop pools equal catalogue 8's
  and old rolls still pick by place. A test holds them equal.
- Season 1's entry doesn't change: only `catalogVersion` moves.

### Replay, before, during and after
- **Before 26 November** no day is a season day. Every log from before rules 17 replays as it ran, as the golden fixture
  (`engine/test/golden.test.ts`) shows.
- **During:**
  - `xp` is a function of the tallies, `activeDays` and the bonuses, so a replay of the same inputs at the same `now`s
    lands on it.
  - Named drops are rolls, recorded with their step, so a replay takes them from the log.
  - The retroactive grants follow the rule in "The exclusives".
- **After `endsOn`,** a day adds nothing. A late event dated inside counts on its day until 31 January, and then
  Season 1 is final.
- **Clock:** the server's `Clock` gives each log row its `now`, and the engine reads no other time. Server tests step a
  `TestClock` over the start and the end in Pacific/Kiritimati, Asia/Jerusalem and Pacific/Pago_Pago. The mod's
  `$.clock` only counts down to the snapshot's instants.

### Local and online
**Both get Season 1:** the local server runs `starterRules`, so a pull and a restart bring the same season. The mod
shows the season only when the server's snapshot has one, so a local server one release behind shows nothing and
breaks nothing.

## Surfaces
### The status line and the band: one compact element
The band folds away by default after the "too much to bear" feedback, and the season must not undo that.
- **One status-line part, last** (PR 2): `⚔ Lv 7 ▰▰▰▱▱ 340/500 xp · 2 missions · last prompt 8.2 · S1 12/30`. It has
  a `season` role in `status.ts`. Being last, it is the first to go on a narrow row, and it shows only while a season
  runs.
- **One moment** (PR 2): `season.tier` plays as a single moment, the tier and its rewards together, with the reward
  drops folded into it rather than played again. Tiers reached together play once, naming the highest.
- **No band row.** In `full` the status line is off, so the Season tab is the place until PR 7 adds `S1 12/30` to the
  top edge's own row.

### The pane: a simple Season tab (PR 2)
A sixth tab after Missions: `{ id: 'season', label: 'Season', short: 'Season', tiny: 'S1' }`. It is ready while the
snapshot has a season, and dim otherwise.
```
 Season 1: Trailhead · ends Sun 24 Jan (31 days)                       tier 12 of 30
 ▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱   240/680 to tier 13
 Today 180/300 · doubled: you had a day off · missions +30 daily, +120 weekly
 Next  13 Knit Scarf · 14 Golden Peach · 15 ★ Pathfinder's Hat (Season 1 only, arrives in December)
 ✓ 1 100 gold  ✓ 2 Sugar Plum  ✓ 3 Kite Hill  …  ✓ 8 ★ Trailhead  ✓ 10 Brass Lantern  ·  12 Snowy Cabin  …
```
Text only: the tiers wrap to the pane's width, the exclusives draw with ★ in their rarity's colour, and there are no
previews. Before the start it shows the date and the rules in three lines, and after the end the final tier.

### The welcome and the update notice
- **New players:** the welcome's last step (`welcome.ts`) gains a line while a season runs: "Season 1 is on:
  everything you earn fills the pass. See the Season tab."
- **Existing players:** PR 2's version bump makes the online server's update notice (`update.ts`) say once that a
  newer mod is out. So PR 2 is released by 20 November, and both daily players update before the start.
- **An older mod** still earns the pass server side, and shows its rewards as drops. It skips `season.tier`, as a
  test with mod 0.14.0's reader checks.

### The profile (PR 6, after the start)
- A `season` section in `profileSections`, shown by default, after `badges`: "Season 1: Trailhead · tier 24 of 30",
  and the exclusives owned.
- No pass XP and no per-day data.
- Files: `server/src/profile.ts`, `server/src/pages.ts`, `schema/src/profile.ts`, `docs/privacy.md` and
  `site/privacy/`.

### The site: the Season 1 page, kept simple (PR 3)
**`https://pathof.dev/season-1/`** (`site/season-1/index.html`), kept after the season as its record:
- The dates, with "started" or a countdown in the reader's zone: one small script, hashed for the CSP by `pnpm site`.
- How the pass fills, in four lines, marked `data-rule` so `site-pages.test.ts` reads the numbers back.
- The 30 tiers as a table, the exclusives named with ★ and "arrives in December". There is no art yet.
- "Do I lose my level? No," and a link to /start/.
- Its own preview card, `site/season-1/og.png`, rendered once from `docs/og-season-1.html` as the home card is.
- A "Season 1" link in the header nav, a changelog entry and two FAQ entries.
- The art drawn on the page, rendered to PNGs by `pnpm site`, comes in PR 8.

### The companion (later)
Home gains `S1 tier 12/30 · 180/300 today` from the snapshot's `season`. PR 1 already lists the field in `unread.txt`.

## Season leaderboard
**Not in Season 1. Later, opt-in, and not before 20 players play a season.**
- **With 4 players** a ranking just names the two daily players, and tells strangers how few play.
- **The pass measures days, not skill:** the cap ties everyone who plays daily at the top.
- **Reported tier:** a ranking would turn a forged event into status.
- **When it comes:**
  - It lists only public profiles whose `season` section is shown, and of those only players who opt in to a new
    `leaderboard` section, which starts hidden as `history` does. A public page is not consent to be ranked.
  - It shows the login, the character name and the tier, and no XP or times.
  - It is served beside `/u/*`, under its rate limit.
  - Going private or deleting the account removes a player at once.
- **No public counts meanwhile** on the Season 1 page while a count could point at a person. The owner reads
  `/pathofdev admin stats`.

## Tests
- **The kernel's properties:**
  - **Order:** any order of a local day's events gives that day the same `value`, and any order of all events gives
    the same `xp`.
  - A day's value never exceeds `perDay × factor`.
  - `tier` never falls, and each tier's rewards are granted once.
  - A day outside the season adds nothing.
  - Dev XP and `xp.carried` add nothing.
  - A mission completed on a season day adds its bonus, whatever day its window began.
- **Replay:**
  - A seeded log across the start, the season, the end and the settle replays to the live state.
  - A log across a deploy that adds an exclusive replays to the live state.
- **Pacing:** the players above, through `step` on a stepped clock. Casual lands at tier 25–27, regular finishes by
  day 56, and heavy no earlier than day 38.
- **Freeze:** Season 1 equals `fixtures/season-1.json`, apart from a later `endsOn`.
- **Server, on PGlite and Postgres:** the start and the end over a `TestClock` in three zones, late events during the
  settle, and the snapshot's `season` in each status.
- **Mod:** the part is last and drops first; the tab in each status at 40, 80 and 120 columns; tiers reached together
  play one moment; glue against `fakeServer`, with and without a season.
- **After the start:** `dealableOf` is the only filter, no exclusive is ever dropped, shelved, crafted or re-rolled,
  and `seasonIssue` refuses an exclusive named twice or by a quest.

## Launch checklist
**By Thursday 26 November:**
- [ ] Step 0 passed, and whatever it found is fixed (see the breakdown).
- [ ] PR 1 deployed online by Wed 18 Nov. The snapshot shows the season as upcoming.
- [ ] PR 2 released by Fri 20 Nov, and both daily players are on it.
- [ ] PR 3 live by Mon 23 Nov: the page says "starts Thursday 26 November".
- [ ] Wed 25 Nov: a dry run on a local server with the dates moved to today, in an uncommitted copy. It covers install,
      a graded prompt, tiers 1–3, a doubled day after a day off, and a mission bonus.
- [ ] The restore drill green that week, and R2's backup fresh. Signup open, and the rate limits checked for a burst.
- [ ] LinkedIn's Post Inspector shows the Season 1 card. The post goes out after 12:00 UTC on the 26th.

**During the season:** PR 4 by Thu 3 Dec, PR 5 by Thu 17 Dec, PR 6 by Thu 10 Dec, PR 7 by Thu 14 Jan. Season counts
in admin stats in week 1.

## PR breakdown (in order)
The build window is 17 days, so only the kernel ships before the start, and each PR is one review.

0. **Step 0: the stranger test (Tue 10 – Wed 11 Nov).** A fresh GitHub account, on a machine with a public Claude Code
   install, follows only https://pathof.dev/start/: the marketplace install, `/pathofdev login`, the welcome, a graded
   prompt and the public profile. Each step is timed, and each place it stalls is written down. The LinkedIn post got
   impressions and no installs, so a broken install comes first. Its fixes are their own small PRs, ahead of PR 1.
   PR 1 starts only when the test passes, or when what fails is understood.
1. **PR 1: the kernel (engine, schema, server), merged and deployed by Wed 18 Nov.**
   - Season 1 in rules 17: dates, cap, rested factor, mission bonus, 30 tiers and their rewards, the exclusives named.
   - `DayTally.pass`, `Holdings.seasons`, `season.ts`, the recount, and tier grants through `rewardDrop`.
   - `season.tier`, the snapshot's `season`, `seasonIssue`, `rules16` kept, engine 17.
   - The contract fixture and `unread.txt`, the freeze fixture, and the pacing test.
2. **PR 2: the mod (0.15.0), released by Fri 20 Nov:** the status line's part, the simple Season tab, the one tier
   moment, the welcome's line, the README and `plugin.json`. It is built against PR 1's branch while that is in
   review.
3. **PR 3: the Season 1 page, live by Mon 23 Nov:** `site/season-1/` (text and the tier table), its card, the nav, the
   changelog, the FAQ and `site-pages.test.ts`.

   **Thursday 26 November: Season 1 starts.**
4. **PR 4: the one pool and Trailhead, by Thu 3 Dec:**
   - `dealableOf` and its consumers, `ItemDef.season`, and exclusives out of the badge metrics and trades.
   - The retroactive grant, catalogue 9 with Trailhead's art, and rules 18.
   - Players past tier 8 get the scene on their next step.
5. **PR 5: the other exclusives and the badge, by Thu 17 Dec:** Pathfinder's Hat, Summit Banner, Switchback Edge and
   Summit at Dawn, with their art and look; Trailblazer and the `seasonTier` metric; catalogue 10 and rules 19.
6. **PR 6: the profile's season section, by Thu 10 Dec,** with `docs/privacy.md`.
7. **PR 7: the bigger moments, by Thu 14 Jan:** `season.ended` (and its moment, needed by 24 January), and the top
   edge's `S1 12/30` in `full`.
8. **PR 8: the art on the site, and the recap, from 1 Feb:** PNGs rendered from the catalogue's art by `pnpm site`, a
   hash test, and the season's final page.
9. **Later:** admin season counts, the companion's line, the title slot and seasonal quests (Season 2), and the
   leaderboard if the numbers allow.

PR 1 is the only one before the start that touches the engine. PRs 4 and 5 each bump the catalogue, so they land in
order. PR 6 is independent.

## Open questions (for the owner)
1. **Is 300 pass XP a day from play the right cap, with tiers 6–30 at 680?**
   - **Recommendation: yes.** The cap sits above a casual day (about 256) and below a regular one (about 500). The costs
     give casual tier 26 and regular the finish with six days to spare, over 60 days with the holidays inside. Tune
     only before 26 November, as the season is frozen from then on.
2. **Is "double after a day off" the rested rule, with no look-back past one day?**
   - **Recommendation: yes.** It is one sentence, derived from the days played, and needs no stored balance. It keeps
     casual near the old pool's share (about 6,700 of 15,800). A longer look-back (k days doubled after k off) would
     pay a week away like a week played, and would need `activeDays` kept much further back.
3. **The badge at tier 30, or for taking part?**
   - **Recommendation: tier 30 (Trailblazer).** Taking part shows on the profile's season card. A badge for finishing
     keeps badges about doing something.
4. **A Season tab, or a section of Missions?**
   - **Recommendation: its own tab, after Missions.** The track needs the room, and the tab is dim between seasons.
5. **May a later season bring back an exclusive, recoloured?**
   - **Recommendation: no.** Each season makes its own items, and `seasonIssue` checks the ids.
6. **Gold past tier 30?**
   - **Recommendation: yes, 100 per 1,000.** That is about 300 gold a week for a daily player, a reason to play on in
     a currency that buys no XP.
7. **When to announce, given Thanksgiving?**
   - **Recommendation:** post on Thursday 26 November after 12:00 UTC for Israel and Europe. Post again on Monday
     30 November, when US readers are back. That is still day 5, with the first double after a day off waiting for
     anyone who joins.
8. **The name "Season 1: Trailhead", and the URL `/season-1/`?**
   - **Recommendation: yes.** The path's first stretch, for the game's first season. The URL stays as its record.
