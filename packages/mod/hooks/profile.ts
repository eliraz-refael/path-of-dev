import type { ProfileSettings } from '@pathofdev/schema'
import type { HttpResponse } from 'claude-code'
import type { PageView } from '../types'
import type { Row, Run } from './cells'
import { dim } from './cells'
import type { Route, Target } from './server'
import { argsOf, commonTextOf, isRecord, messageOf, parsed, printable, publicOrigin, publicSite } from './server'
import { fitting } from './stats'

// What the player's public page shows, from the prompt: `/pathofdev profile [public|private|hide <s>|show <s>]`, on the
// online server. The page is private until the player makes it public; a section is shown unless they hide it. The
// server alone knows which sections there are: the mod sends the word the player typed, and shows what the server
// says, the list of sections included.
//
//   /pathofdev profile ───────────────▶ GET  <origin>/v1/account/profile                  ─┐
//   /pathofdev profile public|private ─▶ POST <origin>/v1/account/profile {kind}           ─┼─▶ Bearer <game token>
//   /pathofdev profile hide|show <s> ──▶ POST <origin>/v1/account/profile {kind, section}  ─┘
//     answer ── 200 ─────────────▶ public or private, what it hides, and its address once there is one
//            ├─ 400 ─────────────▶ the server's line: no such section, and which there are
//            ├─ 401 ─────────────▶ signed out: /pathofdev login
//            └─ none, 429, 5xx ──▶ not answering, or what it answered
//
// The Stats tab and the welcome's last step say where the page is, and whether it is public: the address from the
// server's last answer, else made from the login the snapshot names; whether it is public as the server last said,
// asked when the pane opens and after each `profile` ask, never on a draw. Signed out, they say to sign in; on a local
// server, nothing, as profiles are the online server's alone.

/** What `/pathofdev profile …` asks. */
export type ProfileAsk =
  | { readonly kind: 'view' }
  | { readonly kind: 'public' | 'private' }
  | { readonly kind: 'hide' | 'show'; readonly section: string }

export const profileUsage =
  'Your public profile, on the online server: /pathofdev profile | public | private | hide <section> | show <section>.'

/** What `/pathofdev <args>` asks of the profile: null when the args are not `profile …`, the usage when they don't parse. */
export const profileAskOf = (args: string): ProfileAsk | string | null => {
  const [head, what, section, ...rest] = argsOf(args)
  if (head !== 'profile') return null
  if (rest.length > 0) return profileUsage
  if (what === undefined) return { kind: 'view' }
  if (what === 'public' || what === 'private') return section === undefined ? { kind: what } : profileUsage
  if ((what === 'hide' || what === 'show') && section !== undefined) return { kind: what, section }
  return profileUsage
}

/** The route an ask is sent on, to the online target. */
export const profileRouteOf = (ask: ProfileAsk): Route =>
  ask.kind === 'view' ? { path: '/v1/account/profile' } : { path: '/v1/account/profile', body: ask }

const isSettings = (value: unknown): value is ProfileSettings =>
  isRecord(value) &&
  typeof value['isPublic'] === 'boolean' &&
  Array.isArray(value['hidden']) &&
  Array.isArray(value['sections'])

/** The settings a 2xx answer to a profile ask carries, or null for any other answer. */
export const settingsIn = (response: Pick<HttpResponse, 'ok' | 'text'>): ProfileSettings | null => {
  if (!response.ok) return null
  const body = parsed(response.text)
  return isSettings(body) ? body : null
}

/** Words in a line: "a", "a and b", "a, b and c". */
const listed = (words: ReadonlyArray<string>): string =>
  words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`

/** Where the profile stands, in the player's words: every word from the server printable. */
export const settingsText = (settings: ProfileSettings): string => {
  const sections = settings.sections.map((section) => printable(section, 32)).filter((section) => section !== '')
  const hidden = settings.hidden.map((section) => printable(section, 32)).filter((section) => section !== '')
  const shown = sections.filter((section) => !hidden.includes(section))
  const url = printable(settings.url, 200)
  const page = url === '' ? 'your page' : url
  const showing = shown.length === 0 ? 'only your level' : `your level, ${listed(shown)}`
  const status = settings.isPublic
    ? `Your profile is public: ${page} shows ${showing}.`
    : `Your profile${url === '' ? '' : ` at ${url}`} is private: nobody sees it. /pathofdev profile public shows ` +
      `${showing}.`
  const kept = hidden.length === 0 ? '' : ` Hidden: ${listed(hidden)}.`
  return `${status}${kept} Sections: ${sections.join(', ')}.`
}

/** What the server made of an ask, in the player's words; `response` null: no answer at all. */
export const profileTextOf = (
  ask: ProfileAsk,
  response: Pick<HttpResponse, 'ok' | 'status' | 'text'> | null,
  origin: string,
): string => {
  const common = commonTextOf(response, origin)
  if (common !== null || response === null) return common ?? ''
  if (response.status === 400) {
    const message = messageOf(response.text, 160)
    return message === '' ? profileUsage : `${message}. ${profileUsage}`
  }
  const settings = settingsIn(response)
  if (settings !== null) return settingsText(settings)
  return `The Path of Dev server at ${origin} answered the profile ${ask.kind} with ${response.status}.`
}

/** The GitHub login a snapshot names its player by; null for none, or for a snapshot from before it named one. */
export const loginOf = (snapshot: unknown): string | null => {
  const player = isRecord(snapshot) ? snapshot['player'] : undefined
  const login = isRecord(player) ? player['githubLogin'] : undefined
  return typeof login === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(login) ? login : null
}

/**
 * The page at `origin` once a snapshot names the player `login`: what the server said of it stays while it is the
 * same player's (or the server spoke before the snapshot did); another player's page starts unknown.
 */
export const pageWithLogin = (was: PageView | null, origin: string, login: string | null): PageView =>
  was !== null && was.origin === origin && (was.login === null || was.login === login)
    ? { ...was, login }
    : { origin, login, url: null, isPublic: null }

/** The page at `origin` once the server answered a profile ask with `settings`: the login the snapshot named stays. */
export const pageWithSettings = (was: PageView | null, origin: string, settings: ProfileSettings): PageView => {
  const url = printable(settings.url, 200)
  return {
    origin,
    login: was !== null && was.origin === origin ? was.login : null,
    url: url === '' ? null : url,
    isPublic: settings.isPublic,
  }
}

/**
 * Where the page is: the server's own word when it said, else, on the public server, the address it makes from the
 * login (the site, `/u/`, the login lower-cased); null on another server that hasn't said yet.
 */
export const pageUrlOf = (page: PageView): string | null =>
  page.url ??
  (page.origin === publicOrigin && page.login !== null
    ? `${publicSite}/u/${encodeURIComponent(page.login.toLowerCase())}`
    : null)

/**
 * What the Stats tab and the welcome say of the page: to sign in, or where it is and whether it is public (null: not
 * known yet). Null when there is nothing to say: a local server, which keeps no profile, or no address known yet.
 */
export type PageFacts = { kind: 'signedOut' } | { kind: 'page'; url: string; isPublic: boolean | null }

export const pageFactsOf = (target: Target, isSignedOut: boolean, page: PageView | null): PageFacts | null => {
  if (target.kind !== 'online') return null
  if (isSignedOut) return { kind: 'signedOut' }
  const url = page === null || page.origin !== target.origin ? null : pageUrlOf(page)
  return url === null ? null : { kind: 'page', url, isPublic: page?.isPublic ?? null }
}

/** The address as the player reads it, the scheme left off: `pathof.dev/u/octocat`. */
const shortUrl = (url: string): string => url.replace(/^https:\/\//, '')

const address = (url: string): Run => ({ text: shortUrl(url), color: 'claude' })
const command = (text: string): Run => ({ text, color: 'suggestion' })

/** The Stats tab's line on the page, as it fits `room` cells: the hint goes first, then the label. */
export const pageRow = (facts: PageFacts, room: number): Row => {
  if (facts.kind === 'signedOut') {
    return fitting(
      [
        [dim('Sign in with '), command('/pathofdev login'), dim(' to get a public page')],
        [command('/pathofdev login'), dim(' for a public page')],
      ],
      room,
    )
  }
  const at = address(facts.url)
  const label = dim('Your page: ')
  if (facts.isPublic === null) return fitting([[label, at], [at]], room)
  if (facts.isPublic) return fitting([[label, at, dim(' · public')], [at, dim(' · public')]], room)
  const share = command('/pathofdev profile public')
  return fitting(
    [
      [label, at, dim(' · private: '), share, dim(' to share it')],
      [label, at, dim(' · private: '), share],
      [label, at, dim(' · private')],
      [at, dim(' · private')],
    ],
    room,
  )
}

/** The welcome's word on the page, for a first-timer, as one paragraph. */
export const pageWords = (facts: PageFacts): Row => {
  if (facts.kind === 'signedOut') {
    return [{ text: 'Sign in with ' }, command('/pathofdev login'), { text: ' to get a public page of your own.' }]
  }
  const at: Row = [{ text: 'You also have a page of your own, at ' }, address(facts.url)]
  if (facts.isPublic === null) {
    return [
      ...at,
      { text: ': ' },
      command('/pathofdev profile'),
      { text: " says whether it's public, and " },
      command('/pathofdev profile public'),
      { text: ' shares it.' },
    ]
  }
  if (facts.isPublic) {
    return [
      ...at,
      { text: ", and it's public: anyone with the link can see it. " },
      command('/pathofdev profile private'),
      { text: ' hides it.' },
    ]
  }
  return [
    ...at,
    { text: ". It's private, so nobody sees it until you share it with " },
    command('/pathofdev profile public'),
    { text: '.' },
  ]
}
