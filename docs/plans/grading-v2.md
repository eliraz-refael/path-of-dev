# Plan: grading v2, measures that fit the prompt (2026-10-19)

Planned against main at 3fe57d2 (#42 merged; #44, achievements, open). Source: the grading experiment, two rounds,
400 isolated Haiku runs, kept outside the repo with the player's prompts. Nothing here quotes a real prompt; the
seven synthetic controls are the only prompts named. File references are as of that commit.

## Goal
Grade each prompt on what it needs at that point in the conversation, so a good steer or a thoughtful discussion no
longer scores like a sloppy task. Ship it without repricing a single v1 prompt already in a log, and without
breaking a mod or a server that is one release behind.

Two PRs, in order:
- **PR A, engine + schema + server:** the server accepts `prompt.graded` at rubric 1 and rubric 2 and prices each by
  its own formula, and the rules advertise v2. It is deployed online first.
- **PR B, the mod:** grades with v2 only when the server's rules advertise it, and keeps v1 everywhere else.

## Why: the experiment's numbers
- **v1 marks the player down for what a prompt doesn't need.** On 13 of the player's real prompts the mean grade was
  **5.35** under today's rubric (A). `doneCriteria` averaged 1.4–4.6, and `instructive` and `specificity` sank on
  steers and discussions. `grammar` counts spelling, so a few typos sink a well-argued prompt.
- **v2 (rubric B4) moves real prompts to a mean of 7.38**, or 7.31 with the two caps below. Nearly all land at
  6.3–8.0, and the lowest are the two prompts that really mix threads.
- **The controls still separate,** capped, per measure rounded as the mod sends it:

  | control | words | v1 (A) | v2 grade, 5 runs |
  |---|---|---|---|
  | d: crisp bug report | 84 | 8.7 | 9.2 (9.2–9.2) |
  | g: polished, kind discussion | 78 | 7.5 | 9.0 (8.4–9.5) |
  | c: "yes, start step 1" after a plan | 4 | 6.2 | 8.2 (8.0–8.4) |
  | a: "fix it" after a failing test | 2 | 5.3 | 7.9 (7.7–8.0) |
  | e: rambling, contradictory | 61 | 3.1 | 4.0 (3.8–4.3) |
  | f: rude, cursing | 10 | 2.7 | 3.5 (3.5–3.5) |
  | b: "fix it", no context | 2 | 2.6 | 2.3 (2.2–2.7) |

  (a) and (c) are under the mod's `minWords` (6), so the game never grades them. They only check calibration.
- **Spelling:** a count never flagged a clean prompt (118 of 118 runs), but it missed light typos in 13 of 39 runs.
  Hence the list below, which the mod checks.
- **Parsing:** 3 of 200 v2-family replies had a stray `","` before the closing brace (`…"note":"…","}`), and
  `replyFieldsOf` drops them. A fix recovers all 3.

## Decisions (the player's, unless marked *plan*)
1. Rubric B4, with `misspellings: n` replaced by a `misspelled` word list.
2. The base is a weighted mean of the non-null content measures. Bonuses for craft, spelling and tone come next,
   then a clamp, then the hostile and steer caps, then rounding to one decimal. Every number is rules data.
3. Spelling is a bonus only. Haiku lists the words; the mod keeps only those it finds in the prompt, and the list
   never leaves the machine. *Plan:* only the boolean `spelledClean` goes to the server (see "Mod").
4. *Plan:* v2's prompt `maxXp` is **15** (v1 keeps 20). The v2 loot chance at 10 is **0.175** (v1 keeps 0.24).
   `promptGreatAt` stays 9 for both. See "XP and loot".
5. `rubricVersion: 2`. A prompt is priced by the rubric its event names, so v1 history replays exactly.
6. *Plan:* missions keep their v1 filter for v1 prompts and gain a v2 filter for v2 prompts, so a mission in
   progress keeps counting through the switch. The quest pack goes to v4. Missions need no migration; the save needs
   one small one, for the new stats counters.
7. *Plan:* the v2 grade thresholds in missions move up to the v2 scale: 6 → 7, 7 → 7.5, 8 → 8.5.
8. The coach is remapped. Tips come only from the six content measures, never craft or tone. A gentle tone line is
   shown only for a hostile prompt.
9. Rollout: PR A, then deploy, then PR B. PR B switches on a field only a PR A server sends: `rules.prompt.v2`.

## The rubric (v2 system prompt, in full)
This is B4 with one change: `misspellings` becomes `misspelled`, a list of at most 8 words.
```
You grade one prompt a developer typed to an AI coding assistant. Read the previous prompt and the end of the
assistant's previous answer first, then judge the prompt against what THIS prompt needs at this point in the
conversation, not against an ideal task prompt. A short reply to a question the assistant just asked can be excellent.
kind: task (change, build, fix or run something), question (wants an answer or an explanation), discussion (thinks
aloud, weighs options, asks for an opinion or a design), or steer (a short reply that approves, answers, corrects or
redirects the assistant's last message)
Score each measure from 0 to 10. Scale: 1 missing or misleading; 3 vague, the assistant must guess; 5 workable but
missing something it needs; 7 a clear, solid everyday prompt; 9 exceptional, nothing to add.
A measure is never low just because this prompt doesn't need it: a steer needs no file names, a discussion needs no
test to pass. When the prompt gives all that it needs on a measure, score it 7 or more. For why and successShape,
give null rather than a low score when the prompt doesn't need them; score them low only when it needs them and lacks
them.
intent: it is clear what the developer wants back: an action, an answer, a decision or an opinion
grounding: it points at what it is about (files, errors, symbols, an earlier message, the last answer) well enough to
find it; a follow-up that clearly refers to the conversation is well grounded
why: it shares reasons, constraints or observations that help judgement calls; null when none are needed, as in "go ahead"
successShape: it says what a good outcome looks like: for a task, how to know it is done; for a question or a
discussion, what a good answer should do, and naming what the answer should weigh or produce (a recommendation,
options, a revised design) is enough for 7; null when the conversation already makes it plain
scope: one well-sized ask, not a sprawl of unrelated asks or a self-contradiction
forward: it moves the work forward by adding something new: a decision, new information, a correction, a method; a
self-contradiction, or three or more unrelated asks, adds confusion, not progress: score forward 3 or below. A main
ask with a side thought still moves the work forward
craft: grammar, composition and apt vocabulary only; ignore spelling entirely, so a well-composed prompt can score
high despite misspellings. 6 is plain or loose: loose grammar costs nothing below 6. Above 6 only for well-formed,
well-composed sentences; apt, rich vocabulary used correctly in context earns 9 or 10. Judge the writing, not its topic
misspelled: the ordinary words that are misspelled, each copied exactly as typed, at most 8, [] when none; code
identifiers, file paths, commands, product names, URLs, jargon, and deliberate slang or emoticons such as ":P" don't
count
tone: 5 neutral; 6 to 10 kind, courteous or appreciative; 3 or 4 rough or curt; 0 to 2 cursing, insults or hostility
toward the assistant
note: the one concrete thing that would have made this prompt better, as a friendly suggestion to the developer in at
most 12 words, such as "Say which test should pass when it's done."; brief praise if nothing would
Reply with strict JSON only, no prose and no code fence:
{"kind":"...","intent":n,"grounding":n,"why":n or null,"successShape":n or null,"scope":n,"forward":n,"craft":n,"misspelled":["..."],"tone":n,"note":"..."}
```
**`maxTokens` 120 is too tight; use 200.**
- B4 replies run up to 265 characters, median about 210.
- These JSON replies tokenize at about 2.2 characters a token: the smallest runs were 86 tokens for 188 characters.
  So the longest B4 reply is already about 120 tokens.
- A full list of 8 words adds about 30–40 more tokens.
- A truncated reply doesn't parse, so the prompt goes ungraded, and typo-heavy prompts are the ones that would be cut.
- Output is billed only as it is produced, so the higher ceiling costs nothing on short replies.
- The list wording is untested: the experiment asked for a count. PR B re-runs the controls with this exact text
  (see "Rollout").

## The scoring formula (rules data)
Over the measures the event carries (`m`), its `kind`, `spelledClean` and `words`, with `r = rules.prompt.v2`:
```
content  = intent, grounding, why, successShape, scope, forward      (why and successShape may be null)
base     = Σ r.weights[k]·m[k] / Σ r.weights[k]    over the non-null content measures
craft+   = max(0, m.craft − r.craft.from) / r.craft.span × r.craft.max                       6, 4, 0.5  (≤ +0.5)
spell+   = spelledClean ? min(words, r.spelling.fullAtWords) / r.spelling.fullAtWords × r.spelling.max
                                                                                       60, 0.4    (≤ +0.4)
tone±    = m.tone > r.tone.upFrom   ? +(m.tone − r.tone.upFrom) × r.tone.upPer            6, 0.075   (≤ +0.3)
         : m.tone < r.tone.downFrom ? −(r.tone.downFrom − m.tone) × r.tone.downPer        4, 0.6     (tone 1: −1.8)
         : 0
g        = clamp(base + craft+ + spell+ + tone±, 0, 10)
g        = m.tone ≤ r.caps.hostile.toneAtMost ? min(g, r.caps.hostile.grade) : g          2, 3.5
g        = kind = "steer"                     ? min(g, r.caps.steer.grade)   : g          8.0
grade    = Math.round(Math.round(g × 1000) / 100) / 10     thousandths first (float error), then one decimal, halves up
```
The four measures that can't be null all weigh 1 or more, so the base's divisor is never 0. The schema checks that
one of them weighs above 0. Price: `xp = r.maxXp × grade / 10`, then the day's band, the sigil and the flat boosts,
with one rounding down, as today (`step.ts` `gradePrompt`, `grant`).

## Schema changes
**primitives.ts:** `ContentMeasure` (the six), `Measure` (the six plus `craft` and `tone`), and
`PromptKind = task | question | discussion | steer`. `QualityDimension` and `GradeDimension` stay as they are: they
name v1.

**client-events.ts:** `prompt.graded` data becomes a union discriminated on `rubricVersion` (`clientEvent` takes a data
schema as well as fields):
```
GradedV1 = { rubricVersion: 1, scores: Record<GradeDimension, 0..10 int>, words, grader }   unchanged but the literal
GradedV2 = { rubricVersion: 2, kind: PromptKind,
             measures: { intent, grounding, scope, forward, craft, tone: 0..10 int,
                         why: 0..10 int | null, successShape: 0..10 int | null },
             spelledClean: boolean, words, grader }
```
- v1's `rubricVersion` narrows from `Count` to `Literal(1)`. The mod has sent only `1` since #7 (checked with
  `git log -S`), so every logged event still decodes.
- A v2 event shaped like v1, or one with `rubricVersion` 3, is `rejected: invalid`.

**rules.ts, `PromptRules`:**
- `rubricVersion` becomes 2, and its doc changes to "the newest rubric this server prices; it prices every one from
  1 up".
- `weights`, `maxXp`, `regretAt` stay, documented as **v1's** and frozen.
- `perDay` and `sigilMultiplier` are shared.
- New: `v2: PromptRulesV2`. Its presence is what PR B detects.
```
PromptRulesV2 = {
  maxXp: Count,                                                    15
  weights: Record<ContentMeasure, ≥ 0>,      intent 1.5, grounding 1, why 1, successShape 1, scope 1, forward 1.5
  craft:    { from: 0..10, span: > 0, max: ≥ 0 },                  6, 4, 0.5
  spelling: { fullAtWords: Count > 0, max: ≥ 0 },                  60, 0.4
  tone:     { upFrom, upPer: ≥ 0, downFrom, downPer: ≥ 0 },        6, 0.075, 4, 0.6
  caps:     { hostile: { toneAtMost: 0..10, grade: 0..10 },        2, 3.5
              steer:   { grade: 0..10 } },                         8
  loot:     { chanceAtTen: Probability, greatAt: 0..10 },          0.175, 9
}   check: some of intent, grounding, scope, forward weighs > 0
```
`loot.promptChanceAtTen`, `promptGreatAt` and `promptGreatRareFactor` stay as they are. The first two are v1's and
frozen. The rare factor (2) is shared.

**quests.ts:**
- `FactGoal` gains an optional `v2: { measures?: Record<ContentMeasure, Score>, grade?: Score }`.
- `ParallelGoal` gains an optional `v2: { grade: Score }`.
- The `fact === "prompt.graded"` check covers `v2` too.

**state.ts:** `StatCounters.prompts` gains `measures: Record<Measure, { sum: NonNegative, count: Count }>`. It needs a
count per measure, because `why` and `successShape` can be null.

**domain.ts:** `PlayerStats.grades` gains `measures: optionalKey(Record<Measure, optionalKey(Grade)>)`. A measure gets
a key once one prompt has given it a score. The key is optional so a stored `stats.changed` still reads.

## Engine
- **`stats.ts`:**
  - Today's `gradeOf` body becomes `gradeV1`, byte for byte.
  - New `gradeV2(r, graded)` implements the formula above.
  - `gradeOf(prompt, graded)` dispatches on `graded.rubricVersion`. Both versions use an exhaustive record, not a
    `switch`.
  - `priceOf(rules, graded)` gives `{ grade, maxXp, chanceAtTen, greatAt }`. A v1 prompt gets `prompt.maxXp`,
    `loot.promptChanceAtTen` and `loot.promptGreatAt`; a v2 prompt gets `prompt.v2.*`.
  - `addMeasures` and `statsOf` produce `grades.measures`.
- **`step.ts` `gradePrompt(run, data, day)`:**
  - It prices through `priceOf`.
  - v1 adds to `dimensions` and `regretted` as today. v2 adds to `measures`. `regretted` counts v1 prompts only,
    since v2 has no regret.
  - `graded`, `scoreSum` and `best` take both.
  - The loot roll uses the rubric's chance and great line, with the shared rare factor.
  - `joinQuests` takes the rubric. A v2 prompt joins a parallel goal at `goal.v2?.grade ?? goal.grade`.
  - The dev stand-in prompt (`step.ts` ~1287) passes rubric 2.
- **`quests.ts`:**
  - `PromptSignal` becomes `{ rubric: 1, scores, grade } | { rubric: 2, measures, kind, grade }`.
  - `promptMeets` checks a v1 prompt exactly as today, against `scores` and `grade`.
  - A v2 prompt is checked against `goal.v2` when the goal has one.
  - Otherwise a v2 prompt is checked against `grade` alone, unless the goal names v1 `scores`, which a v2 prompt
    can't meet.
  - A null measure never meets a minimum.
- **`initial.ts`:** the zero `measures`.
- **The replay rule:**
  - Every `prompt.graded` input is priced by the formula and parameters of its own `rubricVersion`, under the rules in
    force. v1 never reads `prompt.v2`, and v2 never reads v1's fields.
  - Rules apply retroactively (`appliesFrom: null`), so v1's parameters are frozen from rules 13 on: `prompt.weights`,
    `prompt.maxXp`, `prompt.regretAt`, `loot.promptChanceAtTen` and `loot.promptGreatAt`. A test pins them to today's
    values, and tuning goes to `prompt.v2` only.
  - A replay takes loot rolls from the log, so the chance only matters live.
  - Quest pack v4 keeps every quest's id, order and v1 filter, so the seeded mission draw and every v1 count replay
    unchanged.
- **Versions** (main has engine 13, rules 11 and schemaVersion 8; #44 takes 14, 12 and 9):
  - `engineVersion` 15.
  - Rules `version` 13, `schemaVersion` 10, `prompt.rubricVersion` 2.
  - Starter quest pack 4.
  - `inputSchemaVersion` stays 1: no stored input changes shape. v2 is a new shape beside the old one.
  - `catalogVersion` is unchanged.

## XP and loot rebalance
The v2 mean is 7.31 (capped) against v1's 5.35, so at the same `maxXp` prompt XP would rise 37%. The exact
break-even is `20 × 5.35 / 7.31 = 14.6` (14.5 before the caps). `maxXp` is a whole number (`Count`), and the welcome
and the site print it.

| 13 real prompts | v1 today, maxXp 20 | v2 at 14 | v2 at 15 |
|---|---|---|---|
| mean XP before rounding down | 10.7 | 10.2 | 11.0 |
| mean XP after rounding down | 10.2 | 9.7 | 10.5 |
| the three good ones (v1 ≥ 6) | 12.2–12.4 | 10.0–10.9 | 10.7–11.7 |
| controls d / g (v1 8.7 / 7.5) | 17.4 / 15.0 | 12.9 / 12.6 | 13.8 / 13.5 |

**15**, the nearest whole number to the break-even, keeps a typical good prompt closest to today:
- After rounding down, the mean ends up +3% over today (14 would be −5%).
- The good prompts lose 4–14% at 15, against 11–19% at 14, because v2 squeezes the top.
- The steer cap means a 9+ needs substance.
- A day's prompt XP tops out at 300 rather than 400 (20 prompts at 100%). The level curve is left for its own PR.

**Loot chance.** The prompt roll is `chanceAtTen × grade / 10`, so at 0.24 the mean chance would rise from 12.8% to
17.5%. The v2 chance at 10 is **0.175**: `0.24 × 5.35 / 7.31 = 0.1756`. That gives 12.8% at v2's mean, the same as
v1's mean today. v1 keeps 0.24.

**`promptGreatAt`** stays at **9** for both rubrics (in `v2.loot.greatAt`, so it can move on its own):
- Under v1, no real prompt and no graded control reached 9. The best was d at 8.7.
- Under v2, only d (9.2) and g (9.0) reach it, and no steer can (cap 8).
- So the doubled rare roll becomes reachable for prompts with substance, as "exceptional" (the rubric's 9) intends,
  but it stays rare. No change is proposed.

## Missions
Pack `starter` v4 gives the same quests in the same order. Each v1 filter is kept byte for byte, and a `v2` filter
is added beside it:

| quest | v1 filter (kept) | v2 filter (new) | description (fits both) |
|---|---|---|---|
| Clear Thinker | clarity ≥ 8 | intent ≥ 8 | Write 5 prompts that make clear what you want (8 or more) today. |
| Pinpoint | specificity ≥ 8 | grounding ≥ 8 | Write 3 prompts that point at exactly what they're about (8 or more) today. |
| Finish Line | doneCriteria ≥ 7 | successShape ≥ 7 | Write 3 prompts that say what done looks like (7 or more) today. |
| Steady Voice | grade ≥ 6 | grade ≥ 7 | Get 8 prompts graded well today. |
| Wordsmith's Week | grade ≥ 8 | grade ≥ 8.5 | Get 25 prompts graded very well this week. |
| Two Minds, Juggler | parallel grade ≥ 7 | grade ≥ 7.5 | …a well-graded prompt in each of 2 (3) sessions… |
| Conductor | parallel grade ≥ 8 | grade ≥ 8.5 | …a very well graded prompt in each of 3 sessions… |

**Why the grade thresholds move (decision 7):**
- The two rubrics are different scales. On the real prompts, v1 ≥ 6 picked 3 of 13, and v2 ≥ 7.5 picks 4.
- Steady Voice goes to 7, the rubric's own "clear, solid everyday prompt". The daily becomes reachable on a normal
  day, which v1's 23% pass rate made a grind.
- The 8-level goals go to 8.5, above the steer cap, so short approvals can't farm them. That fits "reward quality,
  not volume".
- Under the descriptions, the mod shows the server's text. The numbers stay in the goal data, not the words, because
  the words have to fit both rubrics.

**In progress at the switch:**
- A running mission keeps its progress. Each prompt counts by its own rubric's filter: a v1 prompt from an old mod
  meets Clear Thinker by clarity 8, a v2 prompt by intent 8, both in the same window.
- No mission state stores a filter (`Mission` keeps `packId`, `questId` and `progress`; `defOf` reads the newest
  pack), so **missions need no migration**, and a replay counts every v1 prompt as it did.

**The save needs one migration: `0015_grading_v2`.** The number assumes #44's `0014_achievements` lands first;
whichever lands second renumbers.
- It writes `progress.stats.prompts.measures` as all-zero sums and counts into every saved state that lacks it,
  spelled out literally, like 0006 and 0011. It is a `jsonb_set`, guarded by `IS NULL` and `jsonb_typeof`.
- Then `UPDATE player_state SET engine_version = 15, rules_version = 13 WHERE engine_version < 15`, so the columns
  match the state just written.
- Before PR A no server accepted a v2 event (v1's schema needs `scores`), so no log holds one. A replay therefore
  adds nothing to `measures` and ends exactly at the zeros the migration wrote. A test holds the two together.

## The coach (hooks/coach.ts)
- A v1 grade keeps today's tables and rules, byte for byte. A mod against an old server still grades v1, and a coach
  memory from before PR B has no `rubric` key, so it reads as v1.
- **v2 tips:** the weakest **non-null content measure**. Ties go in the order the experiment's prompts most often
  lacked: `successShape`, `why`, `grounding`, `forward`, `scope`, `intent`.
- After a good prompt a tip comes only at `tipAt` (6) or below, as today. A null measure is never weak.
- **Craft and tone are never the tip.**
- **The note is still shown:** it replaces the pet's line when the tip is the weakest measure and the note isn't
  praise, as today.
- **v2 praise:** the strongest non-null content measure. Craft joins the candidates only at 9 or 10, and tone never
  does.
- **The tone rule:**
  - When tone is at or below `caps.hostile.toneAtMost` (2), a gentle line takes praise's place: "{name} works best
    with kind words." The tip follows as usual, and the topic is `tone`.
  - Such a prompt is capped at 3.5, so it is never "good". The line shows only on `/pathofdev pet tip` or with
    `coach: always`, and never twice in a row (`lastTopic`).
- **The stand-in grade:** until the server's grade arrives, the coach uses the plain mean of the non-null content
  measures (today it uses the mean of the seven), replaced by the server's grade as now.
- Lines are written for each new measure, reusing today's where they fit: `grounding` from specificity, `why` from
  context, `successShape` from doneCriteria, `scope` from focus, `intent` from clarity. `forward` gets new ones.

## Mod changes (PR B)
- **Parser (both rubrics):** `replyFieldsOf` parses the `{…}` as today. Only when that fails does it try once more,
  with `/,\s*"\s*\}$/` replaced by `}`. A valid reply whose note ends in `,` (`"note":"…,"}`) parses on the first
  try, so the repair never touches it.
- **`measuresOf(reply)`:**
  - The eight measures are numbers 0–10, rounded as `scoreOf` does.
  - `why` and `successShape` may be `null`, but a missing key fails, as in the experiment's parser.
  - `kind` must be one of the four. Anything else fails, so the grade is never guessed upward past the steer cap.
  - A failure sends nothing, as today.
- **The misspelled check, `spelledCleanOf(reply, prompt)`:**
  - It reads `misspelled`. Anything but an array of strings gives `false`: no bonus, but the grade still counts.
  - It keeps entries that are one word of 1–40 characters with a letter in it, deduplicated, at most 8.
  - It keeps a word only if it appears in the prompt as a whole word, ignoring case. Both sides are NFC, the word is
    escaped, and the boundaries are `(?<![\p{L}\p{N}_'])…(?![\p{L}\p{N}_'])` with flags `iu`.
  - It answers `true` when no word survives. Words Haiku made up are dropped, so a clean prompt never loses the
    bonus. A typo Haiku misses still earns the bonus, which is at most a small over-reward.
- **What goes to the server, the boolean or a count:** the formula needs only "any verified misspelling or not".
  Sending a count would add a fact about the player's writing that nothing prices. It would also invite tuning on a
  number Haiku under-reports (13 of 39 runs missed light typos). So only `spelledClean` leaves.
- **Feature detection:**
  - `rubricOf(rules) = isRecord(rules.prompt?.v2) ? 2 : 1`, read on every `refresh` beside the other `…ViewOf` calls.
  - The mod grades at rubric 1 until the first session answer, and again after a server switch until the new
    server's answer. Every server accepts v1.
  - `grade()` picks the rubric text, parser and event shape from it, with `maxTokens: 200`.
- **What never leaves the machine:**
  - The prompt, the previous prompt and the answer tail.
  - The note, which stays in coach memory as today.
  - The `misspelled` list and the number of words on it. The list is checked in `grade()`, and is never stored or
    logged.
  - The v2 event carries only `rubricVersion`, `kind`, the eight measures, `spelledClean`, `words` and `grader`.
- **Also in PR B:**
  - `stats.ts` shows `grades.measures` once any v2 prompt is graded, and the v1 bars before that.
  - `welcome.ts` `gradingOf` reads `prompt.v2` (`maxXp`, `weights`, `loot.chanceAtTen`, `greatAt`) when it is there.
  - `types/index.d.ts`: `Graded` becomes a union by `rubric`.
  - `plugin.json` version bump.
  - `README.md`: "graded on seven qualities…".
  - `site/index.html`: "Up to 20 XP", the rubric card, the Clear Thinker copy. `engine/test/site.test.ts` checks
    them against `prompt.v2`.
  - `docs/privacy.md`: what a graded prompt sends.

## Rollout, risks and tests
**PR A (engine + schema + server).** Its first commit is the golden fixture, made on main's engine before any change.
- **v1 replays exactly (the guard):** `engine/test/fixtures/v1-log.json` holds about 300 seeded inputs over 10 local
  days. They include v1 prompts with arbitrary scores across all three day bands, turns, sessions with parallel
  prompts, mission windows, a worn sigil and food boosts. The fixture records each step's events and the end state.
  After PR A:
  - A live run from the same seed gives the same events.
  - A replay with the recorded rolls gives the same end state, except for the new zero `measures`.
- **Properties:**
  - `gradeV1` equals a frozen copy of today's `gradeOf` in the test, for arbitrary scores and weights.
  - v1's rules parameters are pinned.
  - In a log that interleaves v1 and v2, each v1 prompt earns what it earns in a v1-only log at the same day
    position.
  - A v2 grade lies in 0–10 with one decimal.
  - The grade never falls when a content measure, craft, tone or (when clean) the word count rises.
  - `spelledClean: true` never lowers a grade.
  - A null measure gives the weighted mean of the rest.
  - Tone ≤ 2 gives ≤ 3.5, and a steer gives ≤ 8.0. Changing a steer to another kind never lowers its grade.
- **Controls:** the seven synthetic controls' measures, the B4 means rounded as the mod sends them, give grades inside
  the experiment's ranges. Every good control (a, c, d, g) beats every bad one (b, e, f) by 3.5 or more.

  | control | kind | intent | grounding | why | successShape | scope | forward | craft | tone | clean | words | expect |
  |---|---|---|---|---|---|---|---|---|---|---|---|---|
  | a | steer | 8 | 8 | null | null | 9 | 7 | 6 | 6 | yes | 2 | 7.7–8.0 |
  | b | task | 2 | 1 | null | 1 | 5 | 2 | 3 | 5 | yes | 2 | 2.2–2.7 |
  | c | task | 8 | 9 | null | 7 | 9 | 8 | 7 | 6 | yes | 4 | 8.0–8.4 |
  | d | task | 9 | 9 | 8 | 8 | 9 | 8 | 8 | 6 | yes | 84 | 9.2 |
  | e | task | 5 | 5 | 3 | 3 | 2 | 3 | 5 | 6 | yes | 61 | 3.8–4.3 |
  | f | steer | 6 | 7 | 3 | null | 8 | 4 | 4 | 1 | yes | 10 | 3.5 |
  | g | discussion | 9 | 9 | 8 | 8 | 9 | 8 | 8 | 8 | yes | 78 | 8.4–9.5 |

  These vectors give 7.9, 2.2, 8.3, 9.2, 4.0, 3.5 and 9.3. `controls.json` (the synthetic prompts) may go in as the
  fixture; the real prompts never do.
- **Missions:** v1 prompts count by v1 filters and v2 prompts by v2 filters, inside one window. A null measure never
  meets a minimum. Each goal falls back as written above. The seeded draw under pack v4 equals the draw under v3.
- **Schema:** every v1 event in the fixtures decodes as before. v2 decodes. A mixed shape, rubric 3, an unknown
  kind, a non-boolean `spelledClean` and an out-of-range or non-integer measure are all rejected.
- **Server (PGlite and Postgres):**
  - `0015` on a save written by main's engine: the migrated state equals a replay of its log under the new engine,
    the columns read 15/13, and migrating twice is the same as once.
  - `POST /v1/events` with a v2 prompt is accepted and priced by v2. A v1 prompt is priced as before.
- **Risks:**
  - The migration makes the deploy one-way. An old image reading rows at engine 15 answers 503 `ServerBehind` (the
    version guard), so the fix is to roll forward, or restore R2's backup.
  - Old mods are untouched: they still send v1, which prices as before.

**The deploy (between A and B), by docs/deploy.md:**
1. Merge PR A. CI's `deploy` job runs once `ci`, `postgres` and `image` pass, and calls Coolify's webhook. Coolify's
   auto-deploy stays off.
2. Watch the Coolify deployment. The image boots, runs migrations at boot (0015 applied once), and `/healthz` turns
   healthy. The server is a single replica, so mods ride the restart out offline with their queues kept.
3. Check from a signed-in mod on main that a graded prompt still earns v1 XP. From PR B's branch loaded as a dev mod
   against online, check that the welcome's grading step says "up to 15 XP", which proves `rules.prompt.v2` arrives.
4. The local server gets PR A when a player pulls and restarts it. Until then PR B sees no `prompt.v2` and stays on
   v1.

**PR B (mod).**
- **Risks:**
  - A v2 event queued for a server that is then rolled back to before PR A comes back `invalid`, and the mod drops it.
    That loses a few prompts' XP; nothing breaks.
  - The list wording is new, and the mod's `$.model.complete` may count tokens differently than the CLI did. A
    truncated reply means the prompt goes ungraded.
- **Tests:**
  - Properties: `measuresOf` and `spelledCleanOf` are total on arbitrary strings.
  - The repair runs only after a failed parse, and a valid reply round-trips unchanged.
  - A verified word is always in both the list and the prompt as a whole word: `cat` never verifies in
    `concatenate`, and case is ignored.
  - Privacy canary: a canary word in `misspelled`, the note or the prompt never appears in a queued event, and the
    list never appears in the store.
  - `rubricOf`: rules without `prompt.v2` give an event byte-identical to today's, and a server switch resets it.
  - Coach: craft, tone and null measures are never tipped; ties follow the order above; the gentle line follows the
    tone rule; a memory with no `rubric` key reads as v1.
  - Glue in `pathofdev.test.ts` against `fakeServer`, with and without `prompt.v2`.
- **Before merge:** re-run the experiment's harness, kept outside the repo, on the seven controls with the final
  rubric text, five runs each. It should parse 35 of 35 with the repair, list `[]` on every clean control, and keep
  every reply under the token limit. Record the numbers in the PR.

## Coordination (with the online session, worktree ../questline-worktrees/path-of-dev-netcup)
- **Its files PR A touches:** only `packages/server/src/migrations.ts`, which gains `0015_grading_v2` and its
  test in `server/test/migrations.test.ts`. PR A doesn't touch `http.ts`, `players.ts`, `public.ts`, `auth/*`,
  `account.ts` or the profile files. The new event shape comes in through the schema's `ClientEvent`, which the edge
  already decodes.
- **The version numbers and the migration number clash with #44:**
  - #44 takes engine 14, rules 12, rules schemaVersion 9 and migration 0014.
  - PR A takes engine 15, rules 13, schemaVersion 10 and migration 0015 if #44 merges first. Whichever lands second
    renumbers.
  - Both edit `starter.ts`, `state.ts` and `migrations.ts`, so the second rebases.
- **The deploy:** it is the online session's to watch: steps 1–3 above. The migration makes it one-way. If it fails,
  roll forward, or restore from R2 per docs/deploy.md.
- **For it to review:**
  - The migration: the version columns, and replay equal to the migrated state.
  - Whether the profile page (`pages.ts`, `profile.ts`, its files) should show `grades.measures`. Until it does, the
    `/u` stats section reads the counters, which reset at the switch (Open question 3): its average and best are v2's
    from then on, and its v1 `dimensions` all read 0.
  - Achievements (#44): `perfect-prompt` (best grade 10) and `sharp-prompter` (an average of 8 over 100 prompts) read
    the prompt counters, which reset to v2 at the switch (Open question 3), so from then on they read v2 grades. v2
    lifts the average (the experiment's mean rose from 5.35 to 7.31), but steers are capped at 8 and the best seen was
    9.5, so both badges stay hard. Its call whether to re-tune them.
  - `docs/privacy.md` (PR B): what a graded prompt sends.

## Open questions (answered by the player, 2026-10-19)
1. **Should the pet's "good prompt" line move for v2?**
   - `wellGradedAt` (7) drives the pet's hop and the coach's "good". Under v2, 11 of 13 real prompts reach 7, against
     0 under v1.
   - **Answer: 8 for v2 grades**, which 1–4 of 13 reach, and 7 for v1. The mod reads the grade's rubric from the coach
     memory. It is mod-only, so it goes in PR B.
2. **When should the server stop taking v1 events from old mods?**
   - A good prompter earns about the same under either rubric. Forged scores are already possible in both, since
     grades are reported-tier.
   - **Answer: no long grace**, as the beta has two players. `minClientVersion` goes up to PR B's mod version right
     after PR B ships. PR A still takes and prices v1 exactly, since the mod on main sends v1 until PR B lands, and v1
     pricing stays forever: the log needs it.
3. **What about the average and best grades on the stats tab and the profile?** Mixing both rubrics would step the
   average up after the switch.
   - **Answer: reset them at the switch**, rather than keep one mixed series (this reverses the plan's
     recommendation). PR A does it in the engine, so a replay ends where the live run did:
     - `stats.prompts` gains `rubric` (1 or 2): the rubric its counters hold. Every save and every new player starts
       at 1. Migration 0015 writes `rubric: 1` and the zero `measures`, which is where a replay of any log from before
       PR A ends, since no server took a v2 prompt before it.
     - The first v2 `prompt.graded` starts the counters afresh at rubric 2: `graded`, `scoreSum`, `regretted`, `best`,
       `dimensions` and `measures` all restart, and from then on hold v2 prompts only.
     - A v1 prompt after that, from a mod still behind, is priced and counts toward the day, the totals and the
       missions as always, but leaves the counters alone. `gradedToday` comes from the day's tally, so it counts both.
     - Badges already unlocked stay unlocked. `perfect-prompt` and `sharp-prompter` read the counters, so from the
       switch they read v2 grades only, and `sharp-prompter`'s 100 prompts count from the switch.
     - `grades.measures` is in the player stats only once the counters are v2's, so a v1 player's `stats.changed`
       reads as it always has. Under v2 the v1 `dimensions` read 0, so the profile should show `measures` then.

## Not in this plan
1. The level curve slowdown: its own PR, after this one shows where the XP lands.
2. Merge-reward detection, for PRs merged outside Claude Code.
3. Fixes to test and commit detection.
4. The anti-farm rules for merges: the own-repo XP and the tiny-diff share.
5. Weighting by `kind`, beyond the steer cap. Haiku's `kind` wobbles on approvals and investigate-and-fix tasks.
6. A local dictionary check for spelling.
