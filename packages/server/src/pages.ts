import type { Gauge } from "@pathofdev/engine"
import type { Criterion, QualityDimension, Rarity } from "@pathofdev/schema"
import { petSprite } from "@pathofdev/schema"
import { createHash } from "node:crypto"
import type { Html } from "./html.ts"
import { html, raw, spriteSvg } from "./html.ts"
import type { PublicBadge, PublicBadges, PublicHistory, PublicProfile } from "./profile.ts"

// The pages `/u/<login>` answers, from a PublicProfile (profile.ts), which holds only what the player shows:
//
//   ┌ nav: Path of Dev ────────────────────────────── What is this? ┐
//   │ ┌ side ──────────┐  ┌ main ───────────────────────────────────┐ │
//   │ │ portrait       │  │ Badges          (badges)                │ │
//   │ │  pet, or glyph │  │ Pet (pet)  │ Streak (streak)            │ │
//   │ │ name, @login   │  │ Prompting       (stats)                 │ │
//   │ │ level · title  │  │ Before Path of Dev (history, opt-in)    │ │
//   │ │                │  └─────────────────────────────────────────┘ │
//   │ │ XP bar         │   a section the player hides is not drawn,   │
//   │ │ mini facts     │   nor named                                  │
//   │ └────────────────┘                                              │
//   └ footer ─────────────────────────────────────────────────────────┘
//
// Every page has the same headers: never cached, since a hide or a delete must take effect at once, and a CSP that
// allows no script, only this style sheet (by hash) and Google's fonts. The 404 is one constant for every reason a
// page is not shown, so its bytes tell a private profile from a missing one no better than its status does.

const css = `
:root {
  --ground: #f5f6f8; --surface: #ffffff; --line: #e2e5eb; --ink: #151922; --muted: #5a6273;
  --accent: #b4720a; --pink: #e2557f; --track: #eceef2;
  --common: #8b93a3; --uncommon: #2f9e5f; --rare: #2f7fe0; --epic: #8a4fd8; --legendary: #c8740c;
  --common-ink: #5d6574; --uncommon-ink: #1d7444; --rare-ink: #1f63bd; --epic-ink: #7238c2; --legendary-ink: #9a5200;
  --sans: "Figtree", system-ui, -apple-system, "Segoe UI", sans-serif;
  --display: "Bricolage Grotesque", "Figtree", system-ui, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ground: #0e1116; --surface: #161a21; --line: #262b35; --ink: #e7eaf0; --muted: #98a1b1;
    --accent: #f0b443; --pink: #ff86a8; --track: #232833;
    --common: #a3abba; --uncommon: #4cc47e; --rare: #58a2ff; --epic: #b083ff; --legendary: #ffa94d;
    --common-ink: #a3abba; --uncommon-ink: #5fd08f; --rare-ink: #6aaeff; --epic-ink: #bb94ff; --legendary-ink: #ffab5c;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--ground); color: var(--ink); font: 400 1rem/1.55 var(--sans);
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px));
}
h1, h2, h3, p, dl, dd, ul { margin: 0; }
ul { padding: 0; list-style: none; }
h1, h2 { text-wrap: balance; }
a { color: inherit; }
a:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 3px; }
.page { max-width: 1040px; margin-inline: auto; padding-block: 0 32px; }
.nav { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding-block: 18px 22px; }
.brand { font: 700 1.05rem/1 var(--display); text-decoration: none; letter-spacing: -0.01em; }
.link { color: var(--muted); font-size: 0.9rem; text-decoration: none; }
.link:hover { color: var(--ink); }
.grid { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 28px; align-items: start; }
.side { display: grid; gap: 10px; min-width: 0; }
.portrait { aspect-ratio: 1; max-width: 100%; background: var(--surface); border: 1px solid var(--line); border-radius: 50%; display: grid; place-items: center; }
.sprite { display: block; width: 62%; shape-rendering: crispEdges; }
.glyph { font-size: 5rem; line-height: 1; }
.name { font: 700 1.6rem/1.15 var(--display); letter-spacing: -0.015em; margin-top: 8px; overflow-wrap: anywhere; }
.login { color: var(--muted); font-size: 1.05rem; overflow-wrap: anywhere; }
.login a { text-decoration: none; }
.login a:hover { text-decoration: underline; }
.rank { font-weight: 600; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.lv { color: var(--accent); }
.prestige { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--accent); border: 1px solid currentColor; border-radius: 4px; padding: 2px 6px; }
.xp { display: grid; gap: 6px; margin-top: 4px; }
.xp p { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 8px; font-size: 0.85rem; color: var(--muted); font-variant-numeric: tabular-nums; }
.xp b { color: var(--ink); }
.bar { display: block; width: 100%; height: 8px; border-radius: 99px; overflow: hidden; }
.bar .track { fill: var(--track); }
.bar .fill { fill: var(--accent); }
.bar.pink .fill { fill: var(--pink); }
.mini { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); border-top: 1px solid var(--line); padding-top: 14px; margin-top: 6px; }
.mini dt { font-size: 0.78rem; color: var(--muted); }
.mini dd { font: 700 1.2rem/1.2 var(--display); font-variant-numeric: tabular-nums; }
.main { display: grid; gap: 16px; min-width: 0; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 20px; min-width: 0; }
.head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 4px 12px; margin-bottom: 14px; }
.head h2 { font: 700 1.05rem/1.2 var(--display); }
.count, .sub, .empty { color: var(--muted); font-size: 0.88rem; }
.sub { margin-top: 10px; }
.count b { color: var(--ink); }
.group { font: 600 0.75rem/1 var(--sans); text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 22px 0 12px; }
.common { --tier: var(--common); --tier-ink: var(--common-ink); }
.uncommon { --tier: var(--uncommon); --tier-ink: var(--uncommon-ink); }
.rare { --tier: var(--rare); --tier-ink: var(--rare-ink); }
.epic { --tier: var(--epic); --tier-ink: var(--epic-ink); }
.legendary { --tier: var(--legendary); --tier-ink: var(--legendary-ink); }
.medals { display: grid; grid-template-columns: repeat(auto-fill, minmax(148px, 1fr)); gap: 12px; }
.medal { display: grid; justify-items: center; align-content: start; text-align: center; gap: 4px; min-width: 0; padding: 16px 10px 14px; border: 1px solid color-mix(in srgb, var(--tier) 38%, var(--line)); border-radius: 12px; background: color-mix(in srgb, var(--tier) 7%, var(--surface)); }
.medal.locked { border-color: var(--line); background: var(--surface); }
.seal { display: grid; place-items: center; width: 64px; height: 64px; margin-bottom: 6px; }
.seal > * { grid-area: 1 / 1; }
.ring { width: 100%; height: 100%; transform: rotate(-90deg); }
.ring .face { fill: color-mix(in srgb, var(--tier) 14%, var(--surface)); }
.ring .track { fill: none; stroke: var(--track); stroke-width: 4; }
.ring .arc { fill: none; stroke: var(--tier); stroke-width: 4; stroke-linecap: round; }
.locked .ring .face { fill: var(--ground); }
.mark { font-size: 1.55rem; line-height: 1; }
.locked .mark { opacity: 0.38; filter: grayscale(1); }
.what { display: grid; justify-items: inherit; gap: 2px; min-width: 0; }
.what b { font-size: 0.875rem; line-height: 1.25; overflow-wrap: anywhere; }
.about { display: none; }
.tag { font-size: 0.72rem; line-height: 1.5; font-weight: 700; color: var(--tier-ink); border: 1px solid color-mix(in srgb, var(--tier) 45%, transparent); background: color-mix(in srgb, var(--tier) 8%, transparent); border-radius: 99px; padding: 0 9px; margin-block: 2px; }
.when { font-size: 0.76rem; color: var(--muted); font-variant-numeric: tabular-nums; }
.pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
.big { font: 700 2.4rem/1 var(--display); font-variant-numeric: tabular-nums; }
.big small { font: 400 1rem/1 var(--sans); color: var(--muted); }
.mood { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: center; font-size: 0.88rem; }
.stats { display: grid; grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr); gap: 24px; }
.facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-content: start; }
.facts b { display: block; font: 700 1.5rem/1.1 var(--display); font-variant-numeric: tabular-nums; }
.facts span { font-size: 0.82rem; color: var(--muted); }
.facts.wide { grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); }
.qualities { display: grid; gap: 9px; }
.quality { display: grid; grid-template-columns: 7rem minmax(0, 1fr) 2.2rem; gap: 12px; align-items: center; font-size: 0.88rem; }
.quality b { text-align: right; font: 700 0.85rem/1 var(--mono); font-variant-numeric: tabular-nums; }
.cells { display: grid; grid-template-columns: repeat(10, minmax(0, 1fr)); gap: 3px; }
.cells i { height: 8px; border-radius: 2px; background: var(--track); }
.cells i.on { background: var(--accent); }
.gone { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 40px 28px; display: grid; gap: 12px; justify-items: start; }
.gone h1 { font: 700 1.8rem/1.15 var(--display); }
.gone p { color: var(--muted); max-width: 34em; }
.foot { margin-top: 28px; color: var(--muted); font-size: 0.85rem; }
@media (max-width: 820px) {
  .grid { grid-template-columns: minmax(0, 1fr); }
  .side { grid-template-columns: 96px minmax(0, 1fr); column-gap: 16px; align-items: center; }
  .portrait { grid-row: span 3; }
  .glyph { font-size: 2.6rem; }
  .xp, .mini { grid-column: 1 / -1; }
  .name { margin-top: 0; font-size: 1.35rem; }
  .stats { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 560px) {
  .medals { grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .medal { grid-template-columns: 48px minmax(0, 1fr) auto; justify-items: start; align-items: center; text-align: left; column-gap: 12px; row-gap: 2px; padding: 10px 12px; }
  .seal { grid-area: 1 / 1 / 3 / 2; width: 48px; height: 48px; margin: 0; }
  .what { grid-area: 1 / 2 / 3 / 3; }
  .about { display: block; font-size: 0.8rem; line-height: 1.35; color: var(--muted); }
  .tag { grid-area: 1 / 3; justify-self: end; }
  .when { grid-area: 2 / 3; justify-self: end; }
  .mark { font-size: 1.25rem; }
}
@media (max-width: 420px) {
  .quality { grid-template-columns: 6.4rem minmax(0, 1fr) 2.2rem; }
}
`

const fonts =
  "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700&family=Figtree:wght@400;600;700&family=JetBrains+Mono:wght@700&display=swap"

const cssHash = createHash("sha256").update(css).digest("base64")

/** The headers of every page, the 404 and the 503 included. */
export const pageHeaders: Readonly<Record<string, string>> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": [
    "default-src 'none'",
    `style-src 'sha256-${cssHash}' https://fonts.googleapis.com`,
    "font-src https://fonts.gstatic.com",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
}

export const pageContentType = "text/html; charset=utf-8"

const home = "https://pathof.dev/"

const document = (title: string, head: Html, body: Html): Html => html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
${head}
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${fonts}">
<style>${raw(css)}</style>
</head>
<body>
<div class="page">
<header class="nav"><a class="brand" href="${home}">Path of Dev</a><a class="link" href="${home}">What is this?</a></header>
${body}
<footer class="foot">An RPG for your Claude Code sessions: every prompt gets graded, and good ones level you up. This page shows what the player chose to share. <a href="${home}">pathof.dev</a></footer>
</div>
</body>
</html>
`

const fmt = (n: number): string => Math.round(n).toLocaleString("en-US")
const grade = (n: number): string => n.toFixed(1)
const day = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
const plural = (n: number, one: string, many: string): string => `${fmt(n)} ${n === 1 ? one : many}`

/** A bar `share` of the way full (0 to 1), drawn as SVG: a page has no inline styles to set a width with. */
const bar = (share: number, kind = ""): Html => {
  const width = Math.round(Math.min(1, Math.max(0, share)) * 1000) / 10
  return html`<svg class="bar ${kind}" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><rect class="track" width="100" height="8"/><rect class="fill" width="${width}" height="8"/></svg>`
}

const cells = (grade: number): Html => {
  const on = Math.round(Math.min(10, Math.max(0, grade)))
  return html`<span class="cells" aria-hidden="true">${Array.from({ length: 10 }, (_, i) => (i < on ? html`<i class="on"></i>` : html`<i></i>`))}</span>`
}

const forms = ["first", "second", "third", "fourth"]

/** The quality names, as the player reads them, in the order the page lists them. */
export const qualityNames: Readonly<Record<QualityDimension, string>> = {
  clarity: "clarity",
  specificity: "specificity",
  instructive: "instructive",
  doneCriteria: "done criteria",
  focus: "focus",
  grammar: "grammar",
  context: "context",
}

const side = (view: PublicProfile): Html => {
  const { character } = view
  const pet = view.pet ?? null
  const mini: ReadonlyArray<readonly [string, string]> = [
    ...(view.badges === undefined ? [] : [["Badges", fmt(view.badges.earned)] as const]),
    ...(view.streak === undefined ? [] : [["Streak", `${fmt(view.streak.days)}d`] as const]),
    ...(view.stats === undefined ? [] : [["Best grade", grade(view.stats.best)] as const]),
  ]
  return html`<aside class="side">
<div class="portrait">${pet === null ? html`<span class="glyph" aria-hidden="true">${character.glyph}</span>` : spriteSvg(petSprite, `${pet.name}, the ${pet.species.toLowerCase()}`)}</div>
<h1 class="name">${character.name}</h1>
<p class="login"><a href="https://github.com/${encodeURIComponent(view.login)}">@${view.login}</a></p>
<p class="rank"><span class="lv">Level ${character.level}</span> · ${character.title} <span aria-hidden="true">${character.glyph}</span>${character.prestige > 0 ? html` <span class="prestige">Prestige ${character.prestige}</span>` : ""}</p>
<div class="xp">${bar(character.xp.forNextLevel === 0 ? 1 : character.xp.intoLevel / character.xp.forNextLevel)}
<p><b>${fmt(character.xp.total)} XP</b><span>${fmt(character.xp.intoLevel)} / ${fmt(character.xp.forNextLevel)} to level ${character.level + 1}</span></p></div>
${mini.length === 0 ? "" : html`<dl class="mini">${mini.map(([term, value]) => html`<div><dt>${term}</dt><dd>${value}</dd></div>`)}</dl>`}
</aside>`
}

const rarityNames: Readonly<Record<Rarity, string>> = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  epic: "Epic",
  legendary: "Legendary",
}

/** A number as a goal reads, to a tenth at most: 8, 7.5. */
const goal = (n: number): string => String(Math.round(n * 10) / 10)

/**
 * How far a locked badge is: the share of its ring (0 to 1, or null where a ring would mislead) and its line. A count
 * fills its ring; an average says where it stands once it covers enough, and how many it covers until then.
 */
export const gaugeOf = (criterion: Criterion, gauges: ReadonlyArray<Gauge>): { share: number | null; text: string } => {
  const [first, average] = gauges
  if (first === undefined) return { share: null, text: "Locked" }
  if (criterion.kind === "count") {
    return { share: Math.min(1, first.current / first.goal), text: `${fmt(Math.min(first.current, first.goal))} / ${fmt(first.goal)}` }
  }
  const unit = criterion.of === "promptGrade" ? "prompts" : "sessions"
  if (average === undefined || first.current < first.goal) return { share: null, text: `${fmt(first.current)} / ${fmt(first.goal)} ${unit}` }
  return criterion.of === "promptGrade"
    // Down to the tenth, so an average just short of its mark never reads as at it.
    ? { share: null, text: `Avg ${grade(Math.floor(average.current * 10 + 1e-9) / 10)} · needs ${goal(average.goal)}` }
    : { share: null, text: `Peak ${fmt(average.current)}% · needs < ${goal(average.goal)}%` }
}

/** The ring around a badge's glyph, `share` of the way round; none drawn for null or 0. */
const ring = (share: number | null): Html => {
  const arc = share === null || share <= 0 ? null : Math.round(Math.min(1, share) * 1000) / 10
  return html`<svg class="ring" viewBox="0 0 64 64" aria-hidden="true"><circle class="face" cx="32" cy="32" r="26"/><circle class="track" cx="32" cy="32" r="29"/>${
    arc === null ? "" : html`<circle class="arc" cx="32" cy="32" r="29" pathLength="100" stroke-dasharray="${arc} 100"/>`
  }</svg>`
}

const medal = (badge: PublicBadge): Html => {
  const isEarned = badge.unlockedAt !== null
  const gauge = badge.gauges === null ? null : gaugeOf(badge.criterion, badge.gauges)
  const when = badge.unlockedAt !== null ? day(badge.unlockedAt) : (gauge?.text ?? "Locked")
  return html`<li class="medal ${badge.rarity}${isEarned ? "" : " locked"}" title="${badge.about}">
<span class="seal">${ring(isEarned ? 1 : (gauge?.share ?? null))}<span class="mark" aria-hidden="true">${badge.glyph}</span></span>
<span class="what"><b>${badge.name}</b><span class="about">${badge.about}</span></span>
<span class="tag">${rarityNames[badge.rarity]}</span><span class="when">${when}</span></li>`
}

const medals = (title: string, badges: ReadonlyArray<PublicBadge>): Html | null =>
  badges.length === 0 ? null : html`<h3 class="group">${title}</h3><ul class="medals">${badges.map(medal)}</ul>`

const badgesCard = (badges: PublicBadges): Html =>
  html`<section class="card" aria-labelledby="badges">
<div class="head"><h2 id="badges">Badges</h2><span class="count"><b>${fmt(badges.earned)}</b> of ${fmt(badges.of)}</span></div>
${
    badges.of === 0
      ? html`<p class="empty">No badges yet.</p>`
      : html`${bar(badges.earned / badges.of)}
${medals("Earned", badges.list.filter((badge) => badge.unlockedAt !== null))}
${medals("Locked", badges.list.filter((badge) => badge.unlockedAt === null))}`
  }
</section>`

const petCard = (pet: NonNullable<PublicProfile["pet"]> | null): Html =>
  pet === null
    ? html`<section class="card" aria-labelledby="pet"><div class="head"><h2 id="pet">Pet</h2></div><p class="empty">An egg, not hatched yet.</p></section>`
    : html`<section class="card" aria-labelledby="pet">
<div class="head"><h2 id="pet">${pet.name}</h2><span class="count">${pet.species.toLowerCase()}, ${forms[pet.form] ?? forms[0]} form</span></div>
<div class="mood"><span>Mood</span>${bar(pet.mood / 100, "pink")}<b>${fmt(pet.mood)}</b></div>
${pet.xpBonusPct > 0 ? html`<p class="sub">Happy, so +${pet.xpBonusPct}% XP</p>` : ""}
</section>`

const streakCard = (streak: NonNullable<PublicProfile["streak"]>): Html =>
  html`<section class="card" aria-labelledby="streak">
<div class="head"><h2 id="streak">Streak</h2></div>
<p class="big">${fmt(streak.days)}<small> ${streak.days === 1 ? "day" : "days in a row"}</small></p>
<p class="sub">Best ${plural(streak.best, "day", "days")} · ${plural(streak.restDaysLeftThisWeek, "rest day", "rest days")} left this week</p>
</section>`

const statsCard = (stats: NonNullable<PublicProfile["stats"]>): Html => {
  const facts: ReadonlyArray<readonly [string, string]> = [
    [fmt(stats.graded), "prompts graded"],
    [grade(stats.averageScore), "average grade"],
    [grade(stats.best), "best grade"],
    [`${fmt(stats.contextPeak)}%`, "average context peak"],
  ]
  return html`<section class="card" aria-labelledby="stats">
<div class="head"><h2 id="stats">Prompting</h2></div>
<div class="stats"><div class="facts">${facts.map(([n, label]) => html`<div><b>${n}</b><span>${label}</span></div>`)}</div>
<div class="qualities">${
    (Object.keys(qualityNames) as Array<QualityDimension>).map((quality) =>
      html`<div class="quality"><span>${qualityNames[quality]}</span>${cells(stats.dimensions[quality])}<b>${grade(stats.dimensions[quality])}</b></div>`
    )
  }</div></div>
</section>`
}

/** The dates an import's counts span, as a page reads them: "Mar 2, 2025 – Oct 8, 2026", or one day alone. */
const spanOf = (first: string | null, last: string | null): string =>
  first === null || last === null ? "" : first === last ? day(first) : `${day(first)} – ${day(last)}`

const historyCard = (history: PublicHistory): Html => {
  const facts: ReadonlyArray<readonly [string, string]> = [
    [fmt(history.prompts), history.prompts === 1 ? "prompt" : "prompts"],
    [fmt(history.sessions), history.sessions === 1 ? "session" : "sessions"],
    [fmt(history.days), history.days === 1 ? "day active" : "days active"],
    [fmt(history.longestStreak), "longest streak, in days"],
    [fmt(history.projects), history.projects === 1 ? "project" : "projects"],
    [fmt(history.toolCalls), history.toolCalls === 1 ? "tool call" : "tool calls"],
    [fmt(history.testRuns), history.testRuns === 1 ? "test run" : "test runs"],
    [fmt(history.commits), history.commits === 1 ? "commit" : "commits"],
  ]
  return html`<section class="card" aria-labelledby="history">
<div class="head"><h2 id="history">Before Path of Dev</h2><span class="count">${spanOf(history.firstDay, history.lastDay)}</span></div>
<div class="facts wide">${facts.map(([n, label]) => html`<div><b>${n}</b><span>${label}</span></div>`)}</div>
<p class="sub">Counted from Claude Code's own records on the player's machine, before they started Path of Dev. No XP comes of it.</p>
</section>`
}

const main = (view: PublicProfile): Html => {
  const pair = [
    view.pet === undefined ? null : petCard(view.pet),
    view.streak === undefined ? null : streakCard(view.streak),
  ].filter((card) => card !== null)
  const cards = [
    view.badges === undefined ? null : badgesCard(view.badges),
    pair.length === 0 ? null : html`<div class="pair">${pair}</div>`,
    view.stats === undefined ? null : statsCard(view.stats),
    view.history === undefined ? null : historyCard(view.history),
  ].filter((card) => card !== null)
  return html`<div class="main">${cards.length === 0 ? html`<section class="card"><p class="empty">This player shows only their level.</p></section>` : cards}</div>`
}

/** A player's page, from what they show; `canonical` is its one address. */
export const profilePage = (view: PublicProfile, canonical: string): string =>
  document(
    `${view.character.name} · Path of Dev`,
    html`<link rel="canonical" href="${canonical}">
<meta name="description" content="${view.character.name}, level ${view.character.level} ${view.character.title} on Path of Dev.">`,
    html`<main class="grid">${side(view)}${main(view)}</main>`,
  ).text

const gone = (title: string, text: Html): string =>
  document(`${title} · Path of Dev`, html`<meta name="robots" content="noindex">`, html`<main class="gone"><h1>${title}</h1><p>${text}</p></main>`)
    .text

/** The one page for every profile not shown: private, missing, deleted, off the beta or never a login. */
export const notFoundPage: string = gone(
  "No profile here",
  html`Either nobody plays under this name, or their profile is private. Players show theirs with <code>/pathofdev profile public</code>.`,
)

/** The page while the database can't be read. */
export const unavailablePage: string = gone(
  "Profiles are down for a moment",
  html`The game's server can't read its saves right now. Try again in a minute.`,
)
