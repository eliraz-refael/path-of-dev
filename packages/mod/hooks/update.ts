import type { ModUpdate } from '../types'

// A newer mod than this one, as the online server tells it: the session's answer names the mod's latest version (the
// one the marketplace offers, which the server is built beside) and the oldest it talks to. A mod behind either says
// so: once on the band, and as a line in the pane for as long as it plays there. A local server tells no latest
// version, as it runs from a clone: there the mod says nothing.
//
//   POST /v1/sessions ─▶ latestModVersion, minClientVersion ─▶ updateOf(clientVersion, …) ─▶ ModUpdate | null
//                                                                 ├─▶ the band: updateLine, once a version (the store)
//                                                                 └─▶ the pane: updateText, under its title

/** The mod's plugin and its marketplace, as `.claude-plugin/marketplace.json` names them. */
export const pluginId = 'pathofdev@path-of-dev'

/**
 * How a player updates the mod, as Claude Code's plugin docs say for a plugin from a marketplace with auto-update off
 * (every third-party one, by default): update the plugin from a shell, then start Claude Code again, which loads it.
 */
export const updateCommand = `claude plugin update ${pluginId}`

type Parsed = { readonly core: readonly [number, number, number]; readonly pre: ReadonlyArray<string> }

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/

/** A semantic version's numbers and pre-release identifiers, or null for anything else; build metadata is dropped. */
const parsedOf = (text: string): Parsed | null => {
  const match = semver.exec(text)
  if (match === null) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}

const sign = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0)

/** Two pre-release identifiers by semver's rule: numbers by value and before words, words by their ASCII order. */
const compareIdentifiers = (a: string, b: string): number => {
  const aNumber = /^\d+$/.test(a)
  const bNumber = /^\d+$/.test(b)
  if (aNumber && bNumber) return sign(Number(a) - Number(b))
  if (aNumber !== bNumber) return aNumber ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * -1, 0 or 1 as version `a` comes before `b`, ranks with it, or after it, by semver's precedence: the numbers in order,
 * then a pre-release before its release, then its identifiers one by one; build metadata counts for nothing. Null when
 * either is not a semantic version.
 */
export const compareVersions = (a: string, b: string): number | null => {
  const left = parsedOf(a)
  const right = parsedOf(b)
  if (left === null || right === null) return null
  for (let i = 0; i < 3; i++) {
    const by = sign((left.core[i] ?? 0) - (right.core[i] ?? 0))
    if (by !== 0) return by
  }
  if (left.pre.length === 0 || right.pre.length === 0) return sign(right.pre.length - left.pre.length)
  for (let i = 0; i < Math.min(left.pre.length, right.pre.length); i++) {
    const by = compareIdentifiers(left.pre[i] ?? '', right.pre[i] ?? '')
    if (by !== 0) return by
  }
  return sign(left.pre.length - right.pre.length)
}

/** Whether `version` is a semantic version newer than `than`. */
const isNewer = (version: unknown, than: string): version is string =>
  typeof version === 'string' && (compareVersions(version, than) ?? 0) > 0

/**
 * The update a mod at `client` has, from what a session's answer said: the latest version when it is newer, or the
 * server's oldest when the mod is under it, whichever is newer; `needs` that oldest when the mod is under it. Null when
 * the mod is up to date, or the server said nothing it can read.
 */
export const updateOf = (client: string, latest: unknown, oldest: unknown): ModUpdate | null => {
  const needs = isNewer(oldest, client) ? oldest : null
  const offered = isNewer(latest, client) ? latest : null
  if (needs === null) return offered === null ? null : { from: client, to: offered, needs }
  const to = offered !== null && (compareVersions(offered, needs) ?? 0) >= 0 ? offered : needs
  return { from: client, to, needs }
}

export const sameUpdate = (a: ModUpdate | null, b: ModUpdate | null): boolean =>
  a === null || b === null ? a === b : a.from === b.from && a.to === b.to && a.needs === b.needs

/** The head of either line: an update there is, or one the server needs. */
const headOf = (found: ModUpdate): string =>
  `${found.needs === null ? 'Update available' : 'Update needed'}: ${found.from} → ${found.to}`

/** The band's one line, which shows once for a version. */
export const updateLine = (found: ModUpdate): string => `${headOf(found)} · ${updateCommand}`

/** The pane's line, in full: what the server needs, if anything, and how to update. */
export const updateText = (found: ModUpdate): string =>
  `${headOf(found)}${found.needs === null ? '' : `: the server needs ${found.needs} or later`} · run ` +
  `${updateCommand} in a shell, then restart Claude Code`

/**
 * Whether the band says `found` this session, given the version the store says the player was last shown: an update
 * the server needs every session, any other once a version.
 */
export const isAnnounced = (found: ModUpdate, seen: unknown): boolean => found.needs !== null || seen !== found.to
