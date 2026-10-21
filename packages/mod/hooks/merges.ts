// The changes the mod saw opened, so it can tell when one merges outside Claude: in the browser, by pr-watch's button
// or by another tool. They are kept per server in the store (`prs@<target>`) by their GitHub names, which stay on the
// machine; a merge leaves as the change's subject in the target's own form, its size, and whether its author owns the
// repo. Only a change the mod saw opened is ever checked, so no merge from before it pays.

/** A change the mod saw opened in a session: its GitHub repo, its number, and when (ms). */
export type Opened = { repo: string; number: number; openedAt: number }

/** How often the mod checks the changes it keeps, past the check at a session's start. */
export const checkEveryMs = 30 * 60 * 1000

/** How long a change stays kept unmerged: one open longer is forgotten. */
export const keptForMs = 30 * 24 * 60 * 60 * 1000

const githubRepo = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/

const isOpened = (value: unknown): value is Opened =>
  typeof value === 'object' &&
  value !== null &&
  'repo' in value &&
  'number' in value &&
  'openedAt' in value &&
  typeof value.repo === 'string' &&
  githubRepo.test(value.repo) &&
  Number.isSafeInteger(value.number) &&
  typeof value.openedAt === 'number'

/** The changes the store keeps, those in another shape left out. */
export const openedOf = (stored: unknown): Array<Opened> => (Array.isArray(stored) ? stored.filter(isOpened) : [])

/** Whether two are the same change. */
export const isSame = (one: { repo: string; number: number }, other: { repo: string; number: number }): boolean =>
  one.repo.toLowerCase() === other.repo.toLowerCase() && one.number === other.number

/** The kept changes with `opened` among them, once: a change opened again keeps when it was first seen. */
export const withOpened = (kept: ReadonlyArray<Opened>, opened: Opened): Array<Opened> =>
  kept.some((one) => isSame(one, opened)) ? [...kept] : [...kept, opened]

/** Whether a kept change is still worth a check at `now`: opened at most `keptForMs` before. */
export const isFresh = (opened: Opened, now: number): boolean => now - opened.openedAt <= keptForMs

/** The repo and number a pull request's URL names (`https://github.com/acme/widgets/pull/7`), or null. */
export const pullOf = (url: string | undefined): { repo: string; number: number } | null => {
  const found = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/.exec(url?.trim() ?? '')
  const repo = found?.[1] ?? ''
  const number = Number(found?.[2] ?? '')
  return githubRepo.test(repo) && Number.isSafeInteger(number) && number > 0 ? { repo, number } : null
}

/** A pull request as `gh pr view --json state,author,additions,deletions` tells it. */
export type View = { state: 'OPEN' | 'MERGED' | 'CLOSED'; author: string | null; additions: number; deletions: number }

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0

/** The view `gh` printed, or null for anything else. */
export const prViewOf = (stdout: string): View | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const state = 'state' in parsed ? parsed.state : undefined
  const additions = 'additions' in parsed ? parsed.additions : undefined
  const deletions = 'deletions' in parsed ? parsed.deletions : undefined
  const author = 'author' in parsed ? parsed.author : undefined
  const login =
    typeof author === 'object' && author !== null && 'login' in author && typeof author.login === 'string'
      ? author.login
      : null
  if (state !== 'OPEN' && state !== 'MERGED' && state !== 'CLOSED') return null
  if (!isCount(additions) || !isCount(deletions)) return null
  return { state, author: login, additions, deletions }
}

/** The login `gh api user --jq .login` printed, or null. */
export const loginOf = (stdout: string): string | null => {
  const login = stdout.trim()
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login) ? login : null
}

/** Whether `login` names the same GitHub account as `other`: logins are told apart by no case. */
export const isLogin = (login: string | null, other: string | null): boolean =>
  login !== null && other !== null && login.toLowerCase() === other.toLowerCase()

/** What a merge says of itself: its size, and whether its repo belongs to its author. Numbers and a yes or no. */
export const factsOf = (repo: string, view: View) => ({
  additions: view.additions,
  deletions: view.deletions,
  isOwnRepo: isLogin(repo.split('/')[0] ?? null, view.author),
})

/** What a check leaves of the kept changes: each one it settled (merged, closed) or that is past `keptForMs` gone. */
export const keptAfter = (
  kept: ReadonlyArray<Opened>,
  settled: ReadonlyArray<{ repo: string; number: number }>,
  now: number,
): Array<Opened> => kept.filter((one) => isFresh(one, now) && !settled.some((done) => isSame(done, one)))
