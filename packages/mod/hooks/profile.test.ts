import type { ProfileSettings } from '@pathofdev/schema'
import { describe, expect, test } from 'claude-code/testing'
import type { PageView } from '../types'
import type { Row } from './cells'
import { cellsOfRow } from './cells'
import type { PageFacts } from './profile'
import {
  loginOf,
  pageFactsOf,
  pageRow,
  pageUrlOf,
  pageWithLogin,
  pageWithSettings,
  pageWords,
  settingsText,
} from './profile'
import type { Target } from './server'

// Where the player's public page is, as the Stats tab and the welcome say it from plain values: the address from the
// server's word or the login, whether it is public as the server last said, and nothing on a local server.

const origin = 'https://api.pathof.dev'
const online: Target = { kind: 'online', origin }
const url = 'https://pathof.dev/u/octocat'
const settings: ProfileSettings = { isPublic: false, hidden: [], sections: ['pet', 'streak', 'stats'], url }
const known = (isPublic: boolean | null): PageView => ({ origin, login: 'Octocat', url: null, isPublic })
const page = (isPublic: boolean | null): PageFacts => ({ kind: 'page', url, isPublic })

const textOf = (row: Row): string => row.map((run) => run.text).join('')
const colorOf = (row: Row, text: string): string | undefined => row.find((run) => run.text === text)?.color

describe('the page in the Stats tab', () => {
  test('says the address in the accent, whether it is public, and the command to share it in the suggestion', () => {
    for (const isPublic of [true, false, null]) {
      expect(pageFactsOf(online, false, known(isPublic))).toEqual(page(isPublic))
    }
    expect(textOf(pageRow(page(true), 100))).toBe('Your page: pathof.dev/u/octocat · public')
    const row = pageRow(page(false), 100)
    expect(textOf(row)).toBe('Your page: pathof.dev/u/octocat · private: /pathofdev profile public to share it')
    expect(colorOf(row, 'pathof.dev/u/octocat')).toBe('claude')
    expect(colorOf(row, '/pathofdev profile public')).toBe('suggestion')
    expect(textOf(pageRow(page(null), 100))).toBe('Your page: pathof.dev/u/octocat')
    const out = pageRow({ kind: 'signedOut' }, 100)
    expect(textOf(out)).toBe('Sign in with /pathofdev login to get a public page')
    expect(colorOf(out, '/pathofdev login')).toBe('suggestion')
  })

  test('gives way on a narrow pane, the hint first and then the label, and never runs past it', () => {
    const facts = page(false)
    expect(textOf(pageRow(facts, 70))).toBe('Your page: pathof.dev/u/octocat · private: /pathofdev profile public')
    expect(textOf(pageRow(facts, 45))).toBe('Your page: pathof.dev/u/octocat · private')
    expect(textOf(pageRow(facts, 32))).toBe('pathof.dev/u/octocat · private')
    expect(textOf(pageRow(page(true), 30))).toBe('pathof.dev/u/octocat · public')
    expect(textOf(pageRow({ kind: 'signedOut' }, 40))).toBe('/pathofdev login for a public page')
    for (const room of [20, 26, 33, 50, 64, 90]) {
      for (const isPublic of [true, false, null]) {
        expect(cellsOfRow(pageRow(page(isPublic), room))).toBeLessThanOrEqual(room)
      }
      expect(cellsOfRow(pageRow({ kind: 'signedOut' }, room))).toBeLessThanOrEqual(room)
    }
  })

  test('says nothing on a local server or the dev sandbox, and to sign in when signed out online', () => {
    expect(pageFactsOf({ kind: 'local' }, false, known(true))).toBeNull()
    expect(pageFactsOf({ kind: 'local', dev: true }, true, known(true))).toBeNull()
    expect(pageFactsOf(online, true, known(true))).toEqual({ kind: 'signedOut' })
    expect(pageFactsOf(online, true, null)).toEqual({ kind: 'signedOut' })
    // Nothing known yet, or what is known is another server's.
    expect(pageFactsOf(online, false, null)).toBeNull()
    expect(pageFactsOf({ kind: 'online', origin: 'https://play.example.com' }, false, known(true))).toBeNull()
  })
})

describe("the page's address", () => {
  test("is the server's word when it said, else the public site's page for the login, lower-cased", () => {
    expect(pageUrlOf(known(null))).toBe('https://pathof.dev/u/octocat')
    expect(pageUrlOf({ ...known(null), url: 'https://example.com/u/octocat' })).toBe('https://example.com/u/octocat')
    expect(pageUrlOf({ ...known(null), login: null })).toBeNull()
    // Another server's site is its own to say.
    expect(pageUrlOf({ ...known(null), origin: 'https://play.example.com' })).toBeNull()
    expect(pageUrlOf({ ...known(null), origin: 'https://play.example.com', url: 'https://play.example.com/u/x' })).toBe(
      'https://play.example.com/u/x',
    )
  })

  test('takes the login a snapshot names, and none from one that names nobody or something else', () => {
    expect(loginOf({ player: { githubLogin: 'Octo-cat' } })).toBe('Octo-cat')
    const nobody = [{}, { player: null }, { player: { githubLogin: null } }, { player: { githubLogin: '../x' } }, null]
    for (const snapshot of nobody) expect(loginOf(snapshot)).toBeNull()
  })

  test("keeps the server's word for the same player, and forgets it for another", () => {
    const told = pageWithSettings(null, origin, settings)
    expect(told).toEqual({ origin, login: null, url: 'https://pathof.dev/u/octocat', isPublic: false })
    // The snapshot came after the server spoke: the same player's page.
    const named = pageWithLogin(told, origin, 'Octocat')
    expect(named).toEqual({ ...told, login: 'Octocat' })
    expect(pageWithLogin(named, origin, 'Octocat')).toEqual(named)
    expect(pageWithLogin(named, origin, 'mona')).toEqual({ origin, login: 'mona', url: null, isPublic: null })
    expect(pageWithLogin(named, 'https://play.example.com', 'Octocat')).toEqual({
      origin: 'https://play.example.com',
      login: 'Octocat',
      url: null,
      isPublic: null,
    })
    expect(pageWithSettings(named, origin, { ...settings, isPublic: true, url: null })).toEqual({
      origin,
      login: 'Octocat',
      url: null,
      isPublic: true,
    })
  })
})

describe("the profile's answer", () => {
  test('names the full address, private or public, and does without it while the server serves none', () => {
    expect(settingsText(settings)).toBe(
      'Your profile at https://pathof.dev/u/octocat is private: nobody sees it. /pathofdev profile public shows your ' +
        'level, pet, streak and stats. Sections: pet, streak, stats.',
    )
    expect(settingsText({ ...settings, isPublic: true })).toBe(
      'Your profile is public: https://pathof.dev/u/octocat shows your level, pet, streak and stats. Sections: pet, ' +
        'streak, stats.',
    )
    expect(settingsText({ ...settings, url: null })).toBe(
      'Your profile is private: nobody sees it. /pathofdev profile public shows your level, pet, streak and stats. ' +
        'Sections: pet, streak, stats.',
    )
  })
})

describe('the page in the welcome', () => {
  test('tells a first-timer where it is and how to share it or hide it, or to sign in for one', () => {
    expect(textOf(pageWords({ kind: 'page', url, isPublic: false }))).toBe(
      "You also have a page of your own, at pathof.dev/u/octocat. It's private, so nobody sees it until you share it " +
        'with /pathofdev profile public.',
    )
    expect(textOf(pageWords({ kind: 'page', url, isPublic: true }))).toBe(
      "You also have a page of your own, at pathof.dev/u/octocat, and it's public: anyone with the link can see it. " +
        '/pathofdev profile private hides it.',
    )
    expect(textOf(pageWords({ kind: 'page', url, isPublic: null }))).toBe(
      "You also have a page of your own, at pathof.dev/u/octocat: /pathofdev profile says whether it's public, and " +
        '/pathofdev profile public shares it.',
    )
    expect(textOf(pageWords({ kind: 'signedOut' }))).toBe(
      'Sign in with /pathofdev login to get a public page of your own.',
    )
    const words = pageWords({ kind: 'page', url, isPublic: false })
    expect(colorOf(words, 'pathof.dev/u/octocat')).toBe('claude')
    expect(colorOf(words, '/pathofdev profile public')).toBe('suggestion')
  })
})
