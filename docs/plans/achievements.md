# Plan: achievements as badges (PRs 7a, 7b, 7c), after /review-plan-deep (2026-10-19)

This plan was written against main at 7f2a59f, after #24–#40 merged. The public server is live at
https://api.pathof.dev and the profile pages at https://pathof.dev/u/<login>. It was built with /create-plan (four
agents: architecture, code design, tests and scope) and reviewed with /review-plan-deep. Every decision below is the
user's. The design-time answers are under "Product decisions" and the review's choices under "Review decisions".

## Goal
The engine unlocks achievements defined in the rules from what it already counts. The mod celebrates each unlock as
it happens. The profile page shows earned badges with their name, rarity colour and "N of M". A player can show off
badges in the band through a showcase slot item.

There are three PRs, in this order:
- **7a, engine and mod celebration:** the definitions in the rules, the unlock pass in `step`, the starter list, a
  lifetime missions counter (migration 0014), and the mod's celebration, band line and toast. There is no page work
  and no showcase.
- **7b, the profile page:** badges with "N of M" and progress for locked badges. Before any code, build a mockup of
  2-3 badge styles in the clean profile look (see the web-design-taste memory: offer directions).
- **7c, the band showcase:** a showcase slot as a loot item in its own band slot, picked badges in it, and rotation.

## Product decisions (user, 2026-10-18)
- Badges are show-off only. They grant no gold, shards or items.
- There are no hidden achievements. Every badge is visible, and locked ones show what earns them and the progress
  toward it.
- Existing players unlock what their present counts already earn, on their next accepted step.
- "First mission done" gets a new lifetime counter of missions completed. It counts from the deploy on; past
  completions aren't in the save and aren't reconstructed.
- The context badge is "25 sessions that never went past 75%". Auto-compact usually fires before 100%, so 100% would
  have been nearly free.
- The collection badge is "a band style in each band slot", counted over a fixed list of slots. "Every band style"
  needs 3 legendaries, and its goal would grow with the catalogue.
- The showcase (7c) is a loot item. It drops, or the shop sells it on a day it's offered, and it sits in its own band
  slot.
  - Common, uncommon and rare each hold 1 badge, with a fancier frame at each rarity. Common is a plain white frame.
  - Epic switches between 2 badges, and legendary cycles through 4, about every 30 seconds.
  - Every player gets a free common one.
- The review badges ("first review", "25 reviews") and "first prestige" are dropped until their source exists:
  - reviews are verified-tier and never counted: `grant` returns before `totals`, at `engine/src/step.ts:414-418`;
  - the mod never sends `review.submitted`;
  - `character.prestige` is still refused, at `step.ts:345`.

## Review decisions (issue → choice)
Architecture
- **A1A.** Volume badges come from reported counts, which a player can fake: `grant` counts totals past the daily cap
  (`step.ts:416-420`), and the private form's key is made on the client. This is accepted for the invite-only beta,
  with a TODO before open signup.
- **A2A.** The collection criterion names its slots in data (`slots: ["xpBar","levelDisplay","topEdge","goldDisplay"]`),
  so 7c's showcase slot can't move its goal.
- **A3A (7c).** Each rarity's showcase frame is a band item's `BandLook` in the catalogue. Capacity and rotation by
  rarity live in the rules. The mod hard-codes no art.
- **A4A.** A returning player's badges appear on their next accepted step. There is no catch-up job and no virtual
  unlock in `project`.

Code quality
- **Q1A.** `Criterion` is a generic count over a typed `Metric` union whose members carry their parameters, plus an
  average criterion (see Schema).
- **Q2A.** One `hasMore` type guard and one `nameOf` switch replace the five `kind==='loot'||kind==='quest'` checks
  (`mod/hooks/celebrate.ts:88-98`, `frames.ts:205-215`), and then `badge` is added.
- **Q3A.** One startup gate: `checkedCatalog` (`server/src/game.ts:13`) becomes `checkedRules`, which runs
  `catalogIssue(…) ?? achievementsIssue(rules, catalog)`.
- **Q4A.** Fix the stale comments listed under "Diagrams and comments" in 7a.

Tests
- **T1A.** The first commit of 7a moves the engine test helpers into `packages/engine/test/play.ts`.
- **T2A.** "Every starter badge is earnable" is one threshold property over the starter list: one below the goal is
  locked, and at the goal it unlocks on the next step.
- **T3A.** The oracle is written over plain `Counts`, never over the state. Integration properties run scripts
  through `step` with small goals (1-5).
- **T4A.** Mod properties go in `packages/mod/test/celebrate.prop.ts`, as `beta.prop.ts` does, plus one mounted check
  in `hooks/pathofdev.test.ts`.

Performance
- **P1A.** The pass exits early when every badge is held. Otherwise it builds the ledger once per step, reading
  ownership through one `Set` of owned item ids against the catalogue, so the cost grows with inventory plus catalogue
  rather than their product.
- **P2A (7b).** Locked progress is measured at render. Caching stays the existing Cloudflare TODO.

## Facts found in the code (drive the design)
- `Holdings.achievements` is `Array<{id, unlockedAt}>`, kept across a rebalance (`schema/src/state.ts:172`). The
  snapshot carries it (`domain.ts:375`), and `profileOf` copies it (`server/src/profile.ts`).
- `achievement.unlocked {achievementId, title}` exists (`server-events.ts:81`), but nothing has ever emitted it, so
  adding a required field needs no migration of stored events.
- `Progress.totals` counts every fact kind, even past the daily cap (`step.ts:416-420`), except verified-tier facts.
- `completedQuests` holds only the current windows (`step.ts:139-140`). There is no lifetime count of missions.
- Context sessions: `StatCounters.context {sessions, peakSum, crossed{pct50,pct75,pct100}, recent}`. A session
  counts toward a mission only once a later session is measured (`quests.ts:181`).
- `gradeOf` rounds to the thousandth (`stats.ts:25`), and `statsOf` gives the rounded averages the player sees.
- `decodeState` is `orDie` (`server/src/writer.ts:92`), so a save missing a required key fails as a defect. A
  migration has to fill new fields.
- `engineVersion` is 13 (`engine/src/version.ts`), and the writer refuses a save from a newer engine with 503
  `ServerBehind` (`writer.ts:84-90`).
- `starterRules` is at version 11, schemaVersion 8 (`engine/src/starter.ts:6-7`). The rules reach the mod in every
  session response (`api.ts`, `register.tsx:609-618`).
- Bookkeeping inputs (`xp.carried`) must do exactly what their migration did (`step.ts:78-83`).
- The writer wakes other sessions only when a step writes events (`writer.ts:274-283`).
- The mod's `joinQueue` folds small celebrations and keeps at most `maxBig = 3` big ones; the rest are dropped
  (`celebrate.ts:105-122`).

## Starter list (19 definitions; ids are permanent and pinned by a test)

| id | name | rarity | criterion |
|---|---|---|---|
| first-commit | First commit | common | count fact `commit.made` ≥ 1 |
| first-merge | First merge | common | count fact `change.merged` ≥ 1 |
| hatched | Hatchling | common | count `hatched` ≥ 1 |
| first-mission | Mission accomplished | common | count `missions` ≥ 1 |
| commits-100 | Committed | uncommon | count fact `commit.made` ≥ 100 |
| merges-50 | Merge train | rare | count fact `change.merged` ≥ 50 |
| prompts-500 | Wordsmith | rare | count fact `prompt.graded` ≥ 500 |
| streak-7 | A week strong | uncommon | count `streak` ≥ 7 |
| streak-30 | Habit formed | epic | count `streak` ≥ 30 |
| streak-100 | Unbroken | legendary | count `streak` ≥ 100 |
| perfect-prompt | Perfect prompt | rare | count `bestGrade` ≥ 10 |
| sharp-prompter | Sharp prompter | epic | average `promptGrade` ≥ 8 over 100 prompts |
| light-context | Light touch | rare | average `contextPeak` < 50 over 30 sessions |
| calm-25 | Never past 75 | rare | count `calmSessions{under: pct75}` ≥ 25 |
| level-10 | Level 10 | common | count `level` ≥ 10 |
| level-25 | Level 25 | rare | count `level` ≥ 25 |
| level-50 | Level 50 | legendary | count `level` ≥ 50 |
| legendary-find | Legendary find | epic | count `owned{rarity: legendary}` ≥ 1 |
| full-band | Full band | epic | count `bandSlots{slots: [xpBar, levelDisplay, topEdge, goldDisplay]}` ≥ 4 |

The names, glyphs and `about` texts are drafts to settle in 7a. Each `about` says what earns the badge, and says
"lifetime" for the averages.

## Architecture

### 7a data flow
```
 mod                         server writer (only place state changes)          engine (pure)
 ───                         ────────────────────────────────────────          ─────────────
 client event / command ─▶   apply: lock row, decode, Context{now, rules, catalog, …}
                               └─▶ step(state, input, ctx)
                                      rollQuests (not for bookkeeping)
                                      dispatch ── complete(): progress.missionsCompleted += 1
                                                  (inside the once-per-window `granted` guard)
                                      refused? ─────────────▶ original state, no unlocks
                                      bookkeeping (xp.carried)? ─▶ as is, no unlocks
                                      else ─▶ unlockAchievements(state', ctx)
                                                every def held? ─▶ as is
                                                ledgerOf ─▶ newlyEarned ─▶ unlock(at = ctx.now)
                                                events appended last: achievement.unlocked{id, title, tier, glyph}
                             ◀── Step; INSERT events, UPDATE state (engine_version 14); notify (events written)
 stream ◀──────────────────────┘
   showBatch: celebrationOf('badge') ─▶ badgeBurstOf (one per batch, more = n−1) ─▶ joinQueue
              gainOf / batchGainOf (badge tone) · toastOf (+ badgePart: names up to 3, counts the rest)
```

### Read path (7b)
```
Players.profile ─▶ one read of the save ─▶ { snapshot = project(...), badgeProgress = progressOf(state, ctx) }
   ─▶ profileOf (allow-list; progress only with stats shown) + rules.achievements ─▶ badgesOf ─▶ badgesCard "N of M"
```

### 7c showcase
```
loot drop / shop ─▶ showcase slot item (category band, slot `showcase`, look = its frame)
item.equip(showcase slot) ─▶ holdings.equipped.showcase
badge.showcase{ids} ─▶ live checks: ids ⊆ earned, unique, ≤ capacity(rarity of the equipped slot)
   ─▶ holdings.showcase ─▶ badge.showcased{ids}   (wakes the other sessions)
project: showcase = held ∩ earned ∩ defined, trimmed to the capacity
mod band row 2: level · gold · [frame(look) + badge glyph, rotating every rules.rotateSeconds] · pet · mission chip
```

### Dependency graph (→ imports)
```
schema/primitives (Glyph, Rarity, BandSlot) ◀── schema/rules.ts (Metric, Criterion, AchievementDef,
                                                  RulesConfig.achievements: defs live here, as MissionRules and
                                                  PetRules do; a separate module would form an import cycle
                                                  with rules.ts over ScoringFact)
                                                  ◀── state.ts · domain.ts · server-events.ts
engine/achievements.ts ─▶ stats.ts (statsOf, settledContext) · streak.ts (bestStreakOf) · loot.ts (rarityRank)
   ◀── step.ts, project.ts      (achievements.ts imports neither: no cycle)
server: writer.ts · game.ts (checkedRules) · migrations.ts (plain SQL) · players.ts ─▶ profile.ts ─▶ pages.ts (7b)
mod/hooks: celebrate · view · frames · register ──type-only──▶ @pathofdev/schema
```

## Schema (7a)
In `schema/src/rules.ts`:
```
Metric =
  | {kind:"fact", fact: ScoringFact}
  | {kind:"streak"} | {kind:"level"} | {kind:"missions"} | {kind:"hatched"} | {kind:"bestGrade"}
  | {kind:"owned", rarity: Rarity}
  | {kind:"bandSlots", slots: NonEmptyArray<BandSlot>}
  | {kind:"calmSessions", under: "pct50" | "pct75" | "pct100"}
Criterion =
  | {kind:"count", of: Metric, atLeast: Goal}
  | {kind:"average", of: "promptGrade" | "contextPeak", atLeast?: Score, below?: Percent, over: Goal}
      (exactly one of atLeast / below)
AchievementDef = {id (pattern /^[a-z][a-z0-9-]{0,31}$/), name: Name, about: String, rarity: Rarity, glyph: Glyph,
                  criterion: Criterion}
RulesConfig.achievements: Array<AchievementDef>
```
- **Filters**, checked by the starter-rules decode test:
  - ids are unique;
  - a `fact` metric never names a fact whose rule is verified-tier;
  - every name and `about` passes `storable`.
- **Reuse:** export `Goal` and `Score` from `schema/src/quests.ts:9-10` rather than defining them again.
- **Version bumps:** `starterRules.version` 11→12 and `schemaVersion` 8→9.
- **State:** `Progress.missionsCompleted: Count`. It is a count the log can rebuild, so it belongs in Progress.
- **Events:** `achievement.unlocked` gains `tier: Rarity` and `glyph: Glyph`, both required.

## Function design

### Composition
```
step ─▶ dispatch ─▶ [refused | bookkeeping] ─▶ unlockAchievements(state, ctx)
          held all?  ─▶ {state, []}
          ledgerOf(state, ctx)          one read: totals, missionsCompleted, bestStreakOf, peakLevel / levelOf,
                                        hatched, statsOf averages and best, settledContext, owned rarities,
                                        band slots with an owned style      (owned ids as a Set)
          gaugesOf(criterion, ledger)   count ─▶ [{current, goal, sense: atLeast}]
                                        average ─▶ [{count, over}, {value, threshold, sense}]
          isEarned = gauges.every(isMet)
          newlyEarned = defs.filter(d => !hasEarned(held, d.id) && isEarned(d.criterion, ledger))
          unlock(state, earned, now) ─▶ {holdings.achievements ++ earned, events = earned.map(unlockedEvent)}
```

### Inventory

**Engine** (`engine/src/achievements.ts` unless noted):

| Function | Signature | Job |
|---|---|---|
| `settledContext` | `(ctx: StatCounters["context"]) → {sessions, peakSum, crossed}` | The context counters without the latest session, still running (as `quests.ts:181`). In `engine/src/stats.ts`. |
| `bestStreakOf` | `(state, rules, now) → number` | `max(progress.bestStreak, current streak)`, moved from `project.ts` and shared. In `engine/src/streak.ts`. |
| `Ledger`, `ledgerOf` | `(state, ctx) → Ledger` | Plain numbers, read once per step. |
| `gaugesOf` | `(criterion, ledger) → Gauge[]` | One exhaustive switch, each case a one-line read. |
| `isMet`, `isEarned`, `hasEarned` | small predicates | `hasEarned` is shared by the engine, `project` and the page. |
| `newlyEarned` | `(defs, held, ledger) → defs` | A filter. |
| `unlockedEvent` | `(def) → ServerEventDraft` | The def as `achievement.unlocked{achievementId, title: name, tier: rarity, glyph}`. |
| `unlock` | `(state, defs, at) → {state, events}` | Append and map, nothing else. |
| `unlockAchievements` | `(state, ctx) → {state, events}` | Exit early when every def is held, else the pipeline. |
| `step` (changed) | — | Runs the pass after the refusal and bookkeeping checks, and appends its events last (`step.ts:89-94`). |
| `complete` (changed) | — | `missionsCompleted + 1` next to `setHoldings({completedQuests})`, inside the `granted` guard (`step.ts:587-599`). |
| `project` (changed) | — | Uses `bestStreakOf`. |
| `initialState` (changed) | — | `missionsCompleted: 0` (`engine/src/initial.ts`). |
| starter definitions | data | In `engine/src/starter.ts`, with the version bumps. |

**Server** (`server/src/game.ts`, `migrations.ts`):

| Function | Signature | Job |
|---|---|---|
| `achievementsIssue` | `(rules, catalog) → string \| undefined` | `defs.map(issueOf).find(defined)`: an `owned` rarity with no item at that rarity, or a `bandSlots` slot with no style. In `schema/src/step.ts`, next to `catalogIssue`. |
| `checkedRules` | `(rules, catalog) → catalog` | Replaces `checkedCatalog`: the first issue throws at startup. |
| migration `0014_achievements` | SQL | `jsonb_set(state,'{progress,missionsCompleted}','0')` where missing; `engine_version = 14`. `engineVersion` 13→14. |

**Mod:**

| Function | Signature | Job |
|---|---|---|
| `hasMore` guard, `nameOf` switch | — | Q2A, in `celebrate.ts` and `frames.ts`. |
| `celebrationOf` (changed) | — | `achievement.unlocked` → `{kind:'badge', tier, title, glyph, more: 0}`. |
| `badgeBurstOf` | `(cs) → cs` | One `reduce`: a batch's badges become the highest-tier one with `more = n−1`. Applied before `joinQueue` in `showBatch` (`register.tsx:~425`). |
| `gainOf` (changed) | — | `{text: "<title> · badge unlocked", tone: 'badge'}`. `toneRank`: level 6 > badge 5 > quest 4. Add `'badge'` to `GainLine.tone` (`types/index.d.ts`) and `toneColor` (`register.tsx`). |
| `badgePart` | `(events) → string[]` | Toast words, spread into `toastOf`'s parts rather than pushed in its loop. |
| frames (changed) | — | A rare badge reuses `missionRows`; epic and legendary reuse `burstRows`; banner text "Badge unlocked". |
| plugin.json | — | Version 0.3.1 → 0.4.0. |

## Test plan

### Arbitraries
- **`Counts`:** plain numbers for:
  - totals per fact, `missionsCompleted`, `bestStreak`, reported XP (gives the level);
  - `prompts {graded, scoreSum, best}` and `context {sessions, peakSum, crossed, recent}`;
  - hatched or not, owned item ids from `starterCatalog` plus one unknown id;
  - `held`, a subset of the def ids.
- **`stateOf(counts)`:** writes those fields into `fresh()` directly.
- **`earnedOracle(criterion, counts)`:** hand-written over `Counts`, never over the state (T3A).
- **`SmallDefs`:** ids `d0..dn`, unique by construction, with goals of 1-5.
- **`DirtyDefs`:** raw records that may hold duplicate ids, goals ≤ 0, a verified fact, unstorable names, and wide
  glyphs.
- **`PlayScript`:** the shared `Script` (from `play.ts`) plus `pet.hatch`, a refused command, `xp.carried`, and missions
  through `starterQuestPack`.

### Coverage map (P = property, E = example, PG = also on the Postgres leg)
```
schema       P rules decode ⇔ defs valid · P round-trip · P every Step's events pass the ServerEvent schema
gaugesOf     P agrees with earnedOracle for every Metric and average · P goal ≥ 1, current ≥ 0, finite
             P averages agree with statsOf at ±0.001 · P exactly at the threshold: "below" is not earned
             P the session still running never counts (settledContext)
             P owned counts only catalogue items of that rarity · P bandSlots counts a style per listed slot only
newlyEarned  P = unheld defs with every gauge met · P subsequence of defs, no held id, no repeats · P splits over concat
step + pass  P frame: with-defs minus badges and unlock events = no-defs (state, events, rolls, refusals)
             P achievements grow as a prefix · P none unlocks twice in a script · P unlockedAt = now, events last,
               tier = rarity, title = name
             P refused → nothing, even with a backlog · P xp.carried → nothing
             P a backlog of k earned defs unlocks exactly those k on the next applied step
             P defs added later unlock on the next applied step; earlier ones never again
             P a replay reproduces the live run (extend step.test.ts:~917 over PlayScript and SmallDefs)
missions     P missionsCompleted = quest.completed events emitted · P never falls
starter      E the exact list and pinned ids (a product decision) · P threshold: each def locked at goal−1 and
               unlocked on the next step at its goal (T2A)
checkedRules P names an owned or bandSlots def the catalogue can't satisfy; the starter rules pass
migration    P(PG) 0014 fills missionsCompleted 0, nothing else changes; engine_version 14 (migrations.test.ts:~289)
write path   P(PG) unlock events stored, streamed and decoded · P(PG) a stored save with a backlog unlocks on its
               next event
mod          P an unlock celebrates at its tier with its name · P an unknown or missing tier plays common
             P badgeBurstOf: no badge silently dropped; one celebration per batch with more = n−1
             P a gain line names the badge; a batch line takes the biggest tone
             P the toast names up to 3 badges and counts the rest, printable
             E one mounted check in hooks/pathofdev.test.ts that a badge celebration plays
```
**Example tests, each justified:**
- **The exact starter list:** it is a product decision, so no property can state it.
- **The mounted check:** mounting the band is too slow for fast-check.

**Prerequisite (T1A):** move `fresh`, `client`, `context`, `nowOf`, `play`, `replay`, `Kind`, `Script` and `toInputs`
from `engine/test/step.test.ts` into `engine/test/play.ts`.

## Failure modes

| Codepath | Failure | Test | Handling | User sees |
|---|---|---|---|---|
| Unlock pass | Unlocks on a refused or bookkeeping step | P | branch before the pass | nothing |
| Unlock pass | The same badge unlocks twice | P | skips held ids | — |
| Context badges | Unlock while the session can still cross | P | `settledContext` | — |
| Average badges | Off by float error at a threshold | P | reads `statsOf` | — |
| Starter list | A badge no input can raise | P (threshold) | `checkedRules` at startup | server won't start, clear message |
| Rules change | Id renamed, unlocks again | E (pinned ids) | ids are permanent | — |
| Rules change | Def removed | P (7b) | orphans dropped from N, M and the showcase | badge disappears |
| Old save | Missing `missionsCompleted` fails decode | P(PG) | migration 0014 + engine 14 | — |
| Rollback | Old build meets an engine-14 save | existing | 503 `ServerBehind` | "try again in a minute" |
| First step after deploy | 10+ unlocks, dropped past `maxBig` | P | `badgeBurstOf`; toast lists all | one celebration, "+N" |
| Older mod | Unknown event and keys | existing | default branches | no celebration |
| Newer mod, older server | No `rules.achievements` | P | badge UI hidden | — |
| Faked counts | Made-up commits unlock volume badges | — | accepted (A1A) + TODO | a fake badge on a profile |

There are no critical gaps. The faked-counts row is a recorded, accepted risk, bounded by the allow-list.

## Implementation order

### 7a (one PR)
1. Move the engine test helpers into `engine/test/play.ts`. This is a refactor only, in its own commit.
2. Schema:
   - `Metric`, `Criterion`, `AchievementDef` and the filters in `rules.ts`, and `RulesConfig.achievements`;
   - export `Goal` and `Score`;
   - `Progress.missionsCompleted`;
   - `tier` and `glyph` on `achievement.unlocked`.
3. Engine:
   - `settledContext` and `bestStreakOf`;
   - `achievements.ts`;
   - the `step` hook and the `complete` counter;
   - `project` and `initialState`;
   - the starter definitions and the rules version bumps;
   - `engineVersion` 14.
4. Server: `achievementsIssue` and `checkedRules`, migration 0014, and the Postgres tests.
5. Mod (can run in parallel with step 4 once step 2 is in):
   - the `hasMore` guard and the `badge` kind;
   - `badgeBurstOf`, the gain line, the toast and the frames;
   - `celebrate.prop.ts`;
   - plugin version 0.4.0.
6. Docs:
   - `TODOS.md` (written with this plan);
   - "As built (7a)" in this file;
   - the README's mention of badges.

### 7b (one PR, after 7a merges)
1. A mockup of 2-3 badge-card styles in the clean profile look, for the user to pick before any page code.
2. `progressOf(state, ctx) → {id, gauges}[]` into the snapshot (`badgeProgress`) for locked defs.
3. `badgesOf(defs, earned, progress) → {badges, earned, of}`:
   - orphaned ids are dropped and not counted;
   - N is the earned ids that are still defined, M is the number of defs;
   - `profileOf` allow-lists it.
4. `badgesCard` with "N of M":
   - uncommon, epic and legendary colours in both themes (pages.ts has only common and rare);
   - no style attributes, under the CSP.
5. **Privacy:** progress gauges for locked badges are drawn only when the `stats` section is public, since they reveal
   counts. Update `docs/privacy.md`.
6. **Tests:**
   - N of M;
   - orphans dropped (update `profile.test.ts:~116`, which expects an undefined id drawn);
   - hostile names escaped;
   - section hidden → no badges;
   - progress hidden with stats;
   - a private profile is still the byte-identical 404.

### 7c (one PR, after 7a; independent of 7b)
- **Schema:**
  - a `showcase` band slot;
  - showcase slot items (category band, slot `showcase`, a `BandLook` frame per rarity);
  - `rules.showcase {capacity: Record<Rarity, n>, rotateSeconds}` (common, uncommon, rare 1; epic 2; legendary 4;
    about 30 s);
  - a `badge.showcase {ids}` command, `Holdings.showcase`, a `badge.showcased {ids}` event, and `Snapshot.showcase`.
- **Engine:**
  - `showcase(state, ids, ctx)` follows `equip`'s pattern, with live-only refusals: `invalid` for a duplicate or over
    capacity, `not_owned` for an unearned badge. An unchanged showcase emits no event.
  - `project` trims the showcase to held ∩ earned ∩ defined, and to the equipped slot's capacity.
  - The free common slot goes into `initialState`.
- **Server:** a migration grants the common slot and `showcase: []` to existing players, with an engine bump. The
  slot items join drops and shop pools.
- **Mod:**
  - the showcase run in band row 2, counted in the widths before the mission chip and dropped whole when it doesn't
    fit;
  - the rotation index from the clock and `rotateSeconds`;
  - the frame from the item's look;
  - `/pathofdev badges` (list earned) and `/pathofdev badges show <ids…> | clear`, through a `badgesAskOf` parser
    modelled on `profileAskOf`.
- **Tests:**
  - showcase ⊆ earned and ≤ capacity over any script;
  - a refusal leaves state equal;
  - setting the same showcase twice is the same as once;
  - the band row ≤ its room;
  - rotation is periodic;
  - an older snapshot shows no showcase.

## As built (7a)
7a follows the plan, with these differences:
- **`Goal` and `Score`** moved into `schema/src/primitives.ts`, and `quests.ts` imports them from there. Exporting
  them from `quests.ts` would have made `rules.ts` import `quests.ts`, which already imports `rules.ts`.
- **The average criterion** is two union members, `{of: "promptGrade", atLeast}` and `{of: "contextPeak", below}`.
  The schema has no optional fields and no "exactly one" filter, since each `of` carries only its own mark.
- **`achievementsIssue(defs, catalog)`** sits next to `catalogIssue` in `schema/src/step.ts`. It names an `owned` or
  `bandSlots` badge whose goal is above what the catalogue holds.
- **`averageOf(sum, count, most)`** in `stats.ts` is the one rounding-and-clamp rule. `statsOf` and the ledger both
  use it, so a badge's average is the one the player sees.
- **The level metric** reads the current level (`levelOf`). Prestige doesn't exist yet, and a held badge is never
  taken back.
- **Migration 0014** starts `missionsCompleted` at the completions the save still holds, those of the current windows
  in `holdings.completedQuests`, instead of 0. A player who finished a mission this week gets the first-mission
  badge on their next step (from the review of #44). It also sets `rules_version = 12`, as 0010 and 0011 did for
  their rules.
- **The rules-decode property** lives in `engine/test/achievements.test.ts`, which has the starter rules. Schema tests
  have no full rules fixture.
- **The mod:**
  - The toast reads `Badges unlocked: 📝 First commit, 💯 Committed and 3 more`.
  - The gain line is `<glyph> <name> · badge unlocked`, in the level's colour.
  - A badge with no glyph shows 🏅, and one with no name shows "Badge". One `badgeOf` / `badgeLabel` pair in
    `celebrate.ts` names a badge for the band, the line and the toast.
  - A common badge in the band's own line shows its glyph where a drop's coin spins.
  - Among small celebrations of the same rarity, a collapse keeps a mission or badge over a level-up, and a level-up
    over a drop. Before the review of #44, a level-up could replace a waiting badge and lose its count.
  - Badge names are drawn as the server sends them, like mission titles, without the ASCII-only `printable`. That
    would strip the glyphs, and the names come from the server's own rules.
- **Plugin 0.4.0** also covers #41 and #42, which shipped as 0.3.1.

Tests:
- `engine/test/achievements.test.ts` has 19 tests: the oracle over `Counts`, the frame property, the backlog, refused
  and bookkeeping steps, defs added later, replay, the missions count, the starter list and its thresholds, and rules
  decode.
- The missions property runs on a busy script of mission work. The shared script rarely completes a mission, so it
  passed even with the counter removed.
- Each engine and mod property was checked to fail when the code under it was broken:
  - `settledContext` counting the running session;
  - `below` taken as `<=`;
  - the held filter removed;
  - the missions counter removed;
  - unlocks on bookkeeping;
  - `bandSlots` counting any style;
  - `unlockedAt` wrong;
  - the rules' `storable` check removed;
  - the verified-fact filter removed;
  - `badgeBurstOf` losing a count or keeping the wrong tier.
- Server:
  - migration 0014 is checked;
  - a stored save's backlog unlocks on its next event, is stored and decodes as `ServerEvent`;
  - a `checkedRules` property covers catalogues that drop a rarity or band slots.
  - The suite passes on PGlite and on Postgres.
- Mod: `test/celebrate.prop.ts`, plus one mounted check that a batch of three plays as its epic with "+2 more".

## As built (7b)

- **Look:** direction C of the mockup (https://claude.ai/artifact/TrJ94seyaQy259oheSUN9t), medal tiles with B's outlined
  rarity tags, picked by the user on 2026-10-21:
  - earned, then locked, each under its own heading;
  - a ring round the glyph: full when earned, filled to a count's share when locked;
  - an average badge has no ring, only its line ("Avg 7.6 · needs 8", or "40 / 100 prompts" until it covers enough);
  - at 560 px and under, each badge is a row that also says what earns it.
- **Progress is not in the snapshot.** `Players.profile` reads the save once and returns the snapshot and
  `progressOf(state, context)`. The mod's snapshot is unchanged, and only the page pays for the ledger. A badges tab in
  the pane would add progress to the snapshot then.
- **`badgesOf(defs, held, progress)`** in profile.ts:
  - every defined badge, once;
  - ids the rules no longer define are dropped and counted nowhere;
  - earned newest first, then locked by a count's share of its goal; averages and ties keep the rules' order;
  - `progress` is null unless `stats` is shown.
- **Colours:** uncommon green, epic purple and legendary orange join common and rare, in both themes, with a darker ink
  for each tag's text.
- **Tests:**
  - engine: `progressOf` is the locked defs' gauges, and none has every gauge met once the unlock pass ran;
  - server: N of M, each badge once, the order, progress only with stats, badge names escaped, `gaugeOf`, and one
    route test over the database (64 commits read as "64 / 100", then "Locked" once stats are hidden).

## NOT in scope
- **Review badges:** nothing counts reviews until the verifier (TODO).
- **Prestige badge:** prestige isn't implemented (TODO).
- **Protecting volume badges against fakes:** accepted for the beta (A1A), with a TODO before open signup.
- **A catch-up job for returning players:** A4A.
- **Rolling "last 100" averages:** lifetime is enough for show-off.
- **Hidden badges and rewards:** the user decided against them.
- **Backfilling the missions counter from the log:** "from deploy on".
- **A badges tab in the pane:** a TODO after 7b.
- **Marking dev-sandbox unlocks:** a local sandbox with its own home.
- **Storing progress:** measured at render (P2A).
- **"3% of players have this":** needs aggregates across players.
- **Achievements on the landing page:** site/ doesn't mention them.

## Diagrams and comments (each updated in the PR that touches it)
- `engine/src/achievements.ts`: the ledger → gauges → newlyEarned → unlock pipeline, and the `Metric` union.
- `engine/src/step.ts`:
  - fix the header "This version covers…" (`:59-65`) to mention achievements;
  - add the pass's branches at `step`.
- `schema/src/state.ts:116`: say that verified-tier facts aren't counted in `totals`.
- `server/src/migrations.ts` 0014: the field it fills and the engine bump.
- `mod/hooks/celebrate.ts`: a batch's badges folding into one celebration before `joinQueue`.
- 7b `server/src/profile.ts`: badges joining the allow-list.
- 7c `mod/hooks/badges.ts`: the showcase in band row 2 and its rotation.
- `TODOS.md`: the old "Achievements, shown as badges" entry is replaced by this plan and the new entries.
