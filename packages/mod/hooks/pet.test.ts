import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On, PromptOrigin, RenderPropsOf, SessionStartInput } from 'claude-code'
import type { ServerEvent } from '@pathofdev/schema'
import type { PetLook, PetPose } from '../types'
import { cellsOf, cellsOfRow } from './cells'
import type { Reaction, StepContext, Walker } from './pet-motion'
import {
  displayAfter,
  displayOf,
  faceOf,
  homeWalker,
  laneRow,
  laneWidthOf,
  petAskOf,
  petRowOf,
  poseOf,
  reactionsOf,
  roomNow,
  settledWalker,
  stepWalker,
  walkerOf,
  wanderLane,
  wellGradedAt,
  withReactions,
} from './pet-motion'

// The living pet: it wanders band row 2, reacts to good play and never to a weak prompt, sleeps when the player is
// away, and stays still or off the band as the player chooses. A small server beneath the mod hands it a hatched pet
// and the stream's events; the band is sampled as the clock moves.

type Dollar = Parameters<TestBody>[0]
type Clock = ReturnType<typeof mock.clock>

const ember = { species: 'fox', name: 'Ember', form: 0, mood: 82, equipped: {} }
const careRules = {
  pet: {
    moodDecayPerDay: 10,
    happyAbove: 70,
    happyXpBonusPct: 5,
    evolveAt: [10],
    care: { fed: 30, petted: 5, pettedPerHour: 3 },
  },
}

const snapshotOf = (pet: unknown) => ({
  serverId: 'local-test',
  streamEpoch: 1,
  cursor: 0,
  pet,
  character: {
    playerId: '01K6ZQ8W3J5V7XKQ2M4N6P8R9T',
    name: 'Player',
    level: 4,
    title: 'Apprentice',
    glyph: '⚔',
    xp: { total: 130, verified: 0, reported: 130, intoLevel: 30, forNextLevel: 203 },
    gold: 25,
    streak: { days: 2, restDaysLeftThisWeek: 1, lastDay: '2026-10-09' },
    equipped: {},
  },
  inventory: [],
  items: [],
})

const reply = (status: number, body: unknown) => ({
  value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) },
})

type Sent = { path: string; body: unknown }

/**
 * The engine beneath the mod, and a local server that answers its routes and hands the stream the test's events.
 * Haiku answers `grader` when there is one.
 */
const world = (
  on: On,
  clock: Clock,
  petOf: () => unknown,
  stream: Array<{ seq: number }>,
  grader: string | null,
  rules: Record<string, unknown>,
) => {
  const sent: Array<Sent> = []
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.cwd', () => ({ value: '/work/widgets' }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('command.run', ($, e) => ({ text: `ran ${e.command}` }))
  on('command.list', () => ({ value: [] }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('audio.play', () => ({ value: undefined }))
  // No grader unless the test brings one: a prompt sent here goes ungraded, and the test hands the stream the grade.
  on('model.complete', () => {
    if (grader === null) throw new Error('no model here')
    return { value: { isAnswered: true, text: grader, usage } }
  })
  on('process.run', () => ({
    value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('http.fetch', async ($, e) => {
    const url = new URL(e.url)
    const body: unknown = e.init?.body === undefined ? undefined : JSON.parse(e.init.body)
    sent.push({ path: url.pathname, body })
    if (e.init?.method === 'DELETE') return reply(200, { closed: true })
    if (url.pathname === '/v1/sessions')
      return reply(200, {
        snapshot: snapshotOf(petOf()),
        rules,
        minClientVersion: '0.0.0',
        acceptedEventTypes: [],
      })
    if (url.pathname === '/v1/events') {
      const events = typeof body === 'object' && body !== null && 'events' in body && Array.isArray(body.events)
        ? body.events
        : []
      const results = events.map((event: { id: string }) => ({ id: event.id, status: 'accepted' }))
      return reply(200, { results, events: [] })
    }
    if (url.pathname === '/v1/commands') return reply(200, { status: 'ok', events: [] })
    // A second at a time, so a test that moves the clock on by minutes doesn't wake it thousands of times.
    for (let waited = 0; waited < 25_000 && stream.length === 0; waited += 1_000) await clock.sleep(1_000)
    const events = stream.splice(0)
    const cursor = Math.max(0, ...events.map((event) => event.seq))
    return reply(200, { events, cursor, rulesVersion: 1, minClientVersion: '0.0.0' })
  })
  return sent
}

const usage = { input_tokens: 812, output_tokens: 41, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

const start: SessionStartInput = { cwd: '/work/widgets', surface: 'terminal', isInteractive: true }
const composer: PromptOrigin = { kind: 'composer' }
const presentation = { isFullscreen: false, columns: 100 }
const bandProps = (isWorking = false): RenderPropsOf['AbovePrompt'] => ({
  hasSurvey: false,
  isWorking,
  maxRows: 20,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
})

const until = async (clock: Clock, check: () => boolean | Promise<boolean>) => {
  for (let round = 0; round < 100; round++) {
    if (await check()) return
    await clock.settle()
  }
  throw new Error('the mod never got there')
}

/**
 * A session with the pet hatched and the stream open; `send` hands the mod events, `store` what it keeps. A test that
 * hatches the pet later puts it in `hatchery`, where the server's snapshots find it; one that grades prompts brings
 * Haiku's reply as `grader`.
 */
const playing = async (
  $: Dollar,
  on: On,
  store: Record<string, unknown> = {},
  pet: unknown = ember,
  hatchery: { pet: unknown } = { pet },
  grader: string | null = null,
  rules: Record<string, unknown> = careRules,
) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-09T08:00:00Z') })
  mock.store(on, { explored: ['acme/widgets'], ...store })
  mock.env(on, { HOME: '/home/player' })
  const stream: Array<{ seq: number }> = []
  const sent = world(on, clock, () => hatchery.pet, stream, grader, rules)
  await $.session.start(start)
  await until(clock, () => sent.some((one) => one.path === '/v1/stream'))
  await clock.settle()
  const send = async (...events: Array<{ seq: number }>) => {
    stream.push(...events)
    await clock.advance(1_000)
    await until(clock, () => stream.length === 0)
    await clock.settle()
  }
  return { clock, send, sent }
}

const mountBand = ($: Dollar, isWorking = false) =>
  $.ui.mount({ plugin: 'pathofdev', surface: 'terminal', component: 'AbovePrompt', props: bandProps(isWorking) })
type Band = Awaited<ReturnType<typeof mountBand>>

/** The pet's piece of band row 2 in a drawing (its lane, name and hearts), or null when it draws none. */
const petIn = async (ui: Band): Promise<string | null> =>
  (await ui.find({ type: 'Box', key: 'band:lane' }))?.text ?? null

/** The pet's piece of band row 2 now. */
const petText = async ($: Dollar, isWorking = false): Promise<string | null> => {
  const ui = await mountBand($, isWorking)
  const text = await petIn(ui)
  await ui.unmount()
  return text
}

/** Watches the pet for `ms`, a look every `every` ms, keeping each change and when it came. */
const changes = async ($: Dollar, clock: Clock, ms: number, every = 250) => {
  const ui = await mountBand($)
  const seen: Array<{ at: number; text: string | null }> = []
  for (let at = 0; at < ms; at += every) {
    const text = await petIn(ui)
    if (seen.at(-1)?.text !== text) seen.push({ at: clock.now(), text })
    await clock.advance(every)
  }
  await ui.unmount()
  return seen
}

/** Where the face starts in the pet's text: its cells from the lane's left edge. */
const faceAt = (text: string | null, face = /ᓚᘏᗢ|ᗢᘏᓗ/): number => {
  if (text === null) return -1
  const match = face.exec(text)
  return match === null ? -1 : cellsOf(text.slice(0, match.index))
}

let seq = 0
const serverEvent = (type: string, data: Record<string, unknown>, cause: string | null = null) => ({
  seq: ++seq,
  at: '2026-10-09T08:00:00.000Z',
  cause,
  type,
  data,
})
const graded = (grade: number, cause: string) =>
  serverEvent('xp.granted', { amount: 12, tier: 'reported', reason: 'prompt.graded', grade, totalAfter: 150 }, cause)
const dropped = (tier: string, cause: string) =>
  serverEvent(
    'loot.dropped',
    {
      entry: {
        id: '01K6ZQ8W3J5V7XKQ2M4N6P8R9T',
        itemId: 'cap',
        acquiredAt: '2026-10-09T08:00:00Z',
        source: { kind: 'drop', ref: '1' },
        dye: null,
      },
      item: {
        id: 'cap',
        name: 'Wool Cap',
        rarity: tier,
        category: 'wearable',
        slot: 'head',
        sprite: null,
        lore: null,
        effect: null,
      },
      gold: 0,
      pity: { sinceRare: 0, sinceEpic: 0 },
      tier,
    },
    cause,
  )

/** A turn the player started and the agent finished, holding the band while it ran. */
const turn = async ($: Dollar, clock: Clock, during: () => Promise<void> = async () => undefined) => {
  await $.prompt.submit({ text: 'fix the parser so it reads nested lists', wait: false, origin: composer })
  await $.turn.start({ text: 'fix the parser', turnId: 't1' })
  await during()
  await $.turn.complete({ answer: 'Done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
}

describe('the pet wanders', () => {
  test('band row 2 at about 2 fps: walks, pauses and turns around inside its lane, beside its name', async ($, on) => {
    const { clock } = await playing($, on)
    const seen = await changes($, clock, 15_000)
    const texts = seen.map((one) => one.text)
    // It moved, both ways, and faced both ways.
    expect(new Set(texts.map((text) => faceAt(text))).size).toBeGreaterThan(3)
    expect(texts.some((text) => text?.includes('ᗢᘏᓗ'))).toBe(true)
    expect(texts.some((text) => text?.includes('ᓚᘏᗢ'))).toBe(true)
    // Never quicker than a step every half second, and it rests between walks.
    const gaps = seen.slice(1).map((one, i) => one.at - (seen[i]?.at ?? 0))
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(500)
    expect(Math.max(...gaps)).toBeGreaterThan(1_000)
    // The lane holds it: always the same width, its name and hearts after it.
    for (const text of texts) {
      expect(text).toMatch(/ Ember ♥♥♥$/)
      expect(cellsOf(text ?? '')).toBe(cellsOf(texts[0] ?? ''))
      expect(faceAt(text)).toBeGreaterThanOrEqual(1)
    }
    expect(cellsOf(texts[0] ?? '') - cellsOf(' Ember ♥♥♥')).toBe(wanderLane)
  })

  test('writes what the band draws of it only when that changed: a rest redraws nothing', async ($, on) => {
    const writes: Array<unknown> = []
    on('state.set', ($, e, next) => {
      if (e.plugin === 'pathofdev' && e.key === 'pet') writes.push(e.value)
      return next(e)
    })
    const { clock } = await playing($, on)
    const before = writes.length
    const seen = await changes($, clock, 15_000)
    // Each write moved the pet; a look every 250 ms sees every one of them, as steps come at least 500 ms apart.
    expect(writes.length - before).toBeGreaterThan(3)
    expect(writes.length - before).toBe(seen.length - 1)
  })

  test('rests through a main-loop turn, and wanders again once it ends', async ($, on) => {
    const { clock } = await playing($, on)
    await $.turn.start({ text: 'fix the parser', turnId: 't1' })
    await clock.settle()
    expect((await changes($, clock, 10_000)).length).toBe(1)
    await $.turn.complete({ answer: 'Done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    expect((await changes($, clock, 20_000)).length).toBeGreaterThan(3)
  })

  test('a reload starts its timers again, one step at a time, not two', async ($, on) => {
    const { clock } = await playing($, on)
    await clock.advance(5_000)
    await $.session.start(start)
    await clock.settle()
    const seen = await changes($, clock, 20_000)
    expect(seen.length).toBeGreaterThan(3)
    const gaps = seen.slice(1).map((one, i) => one.at - (seen[i]?.at ?? 0))
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(500)
  })

  test('keeps wandering after a /clear starts the session again', async ($, on) => {
    const { clock, sent } = await playing($, on)
    const opened = () => sent.filter((one) => one.path === '/v1/sessions').length
    await $.session.end({ reason: 'clear', sessionId: 'first', resume: { id: 'first' } })
    await until(clock, () => opened() === 2)
    expect((await changes($, clock, 20_000)).length).toBeGreaterThan(3)
  })

  test('a click on the blank it wanders in pats nothing: only the pet and its name take one', async ($, on) => {
    const { clock } = await playing($, on)
    const ui = await mountBand($)
    for (let at = 0; at < 6_000; at += 500) {
      const lane = (await petIn(ui)) ?? ''
      const button = (await ui.find({ type: 'Button', key: 'band:pet' }))?.text
      expect(lane.startsWith(' ')).toBe(true)
      expect(button).toBe(lane.trimStart())
      await clock.advance(500)
    }
    await ui.unmount()
  })
})

describe('the pet reacts', () => {
  test('hops for a prompt graded 7 or more once the turn is over; a weaker or ungraded one, nothing', async ($, on) => {
    const { clock, send } = await playing($, on, { petDisplay: { hidden: false, still: true } })
    const sitting = await petText($)
    expect(sitting).toBe(' ᓚᘏᗢ  Ember ♥♥♥')
    // A weak prompt, and a turn with no grade at all: the pet sits as it was.
    await turn($, clock, () => send(graded(4, 'p1')))
    expect((await changes($, clock, 5_000)).map((one) => one.text)).toEqual([sitting])
    await turn($, clock)
    expect((await changes($, clock, 5_000)).map((one) => one.text)).toEqual([sitting])
    // A good one: nothing while the turn runs; once the prompt is idle and the XP has played, a hop.
    await turn($, clock, async () => {
      await send(graded(7, 'p2'))
      expect(await petText($, true)).toBe(sitting)
    })
    const hop = (await changes($, clock, 4_000)).map((one) => one.text)
    expect(hop).toContain('✧ᓚᘏᗢ✧ Ember ♥♥♥')
    expect(hop).toContain(' ᓚᘏᗢ♪ Ember ♥♥♥')
    expect(hop.at(-1)).toBe(sitting)
  })

  test('a grade the band shows as 7 hops, one it shows as 6.9 does not, and a grant with no grade nothing', () => {
    const at = (grade?: number) => reactionsOf([grant(grade)], 'full').map((one) => one.kind)
    expect(at(6.96)).toEqual(['hop'])
    expect(at(6.94)).toEqual([])
    expect(at(10)).toEqual(['hop'])
    // An older server names no grade on the grant: no well-graded prompt.
    expect(at()).toEqual([])
    // XP for anything but a prompt is no prompt at all.
    const commit: ServerEvent = {
      seq: 2,
      at: '2026-10-09T08:00:00.000Z',
      cause: null,
      type: 'xp.granted',
      data: { amount: 12, tier: 'verified', reason: 'commit.made', totalAfter: 150, grade: 9 },
    }
    expect(reactionsOf([commit], 'full')).toEqual([])
  })

  test("a rubric 2 prompt hops at its own line, 8: its grades run higher than rubric 1's", () => {
    const at = (grade: number) => reactionsOf([grant(grade)], 'full', wellGradedAt[2]).map((one) => one.kind)
    expect(at(7.5)).toEqual([])
    expect(at(7.94)).toEqual([])
    expect(at(7.96)).toEqual(['hop'])
    expect(reactionsOf([grant(7.5)], 'full', wellGradedAt[1]).map((one) => one.kind)).toEqual(['hop'])
  })

  test('eats when fed, and enjoys a pat', async ($, on) => {
    const { clock, send } = await playing($, on, { petDisplay: { hidden: false, still: true } })
    const biscuit = { entryId: 'e', itemId: 'honey-biscuit', name: 'Honey Biscuit', mood: 100, gained: 30 }
    await send(serverEvent('pet.fed', biscuit, 'f1'))
    const meal = (await changes($, clock, 3_000)).map((one) => one.text)
    expect(meal).toContain(' ᓚᘏᗢ● Ember ♥♥♥')
    expect(meal).toContain(' ᓚᘏᗢ· Ember ♥♥♥')
    await send(serverEvent('pet.petted', { mood: 95, gained: 5 }, 'f2'))
    const pat = (await changes($, clock, 3_000)).map((one) => one.text)
    expect(pat).toContain(' ᓚᘏᗢ♥ Ember ♥♥♥')
    expect(pat).toContain(' ᓚᘏᗢ♡ Ember ♥♥♥')
  })

  test('a pat gets it up from a rest at once, not when the rest would have ended', async ($, on) => {
    // A sleepy pet rests 3 to 12 seconds between walks.
    const { clock, send } = await playing($, on, {}, { ...ember, mood: 20 })
    const ui = await mountBand($)
    let quiet = 0
    let last = await petIn(ui)
    for (let round = 0; quiet < 750 && round < 400; round++) {
      await clock.advance(250)
      const now = await petIn(ui)
      quiet = now === last ? quiet + 250 : 0
      last = now
    }
    await ui.unmount()
    // At rest now, with 2 seconds of it left at least; the pat arrives within one of them, and shows straight away.
    expect(quiet).toBe(750)
    await send(serverEvent('pet.petted', { mood: 25, gained: 5 }, 'f1'))
    const seen = (await changes($, clock, 500)).map((one) => one.text ?? '')
    expect(seen.some((text) => /ᓚᘏᗢ[♥♡]|[♥♡]ᗢᘏᓗ/.test(text))).toBe(true)
  })

  test('what happens before it hatches is not saved up for the pet that hatches later', async ($, on) => {
    const hatchery: { pet: unknown } = { pet: null }
    const { clock, send } = await playing($, on, {}, null, hatchery)
    await turn($, clock, () => send(graded(9, 'p1'), dropped('uncommon', 'p1')))
    await clock.advance(10_000)
    hatchery.pet = ember
    await send(serverEvent('pet.hatched', { species: 'fox', name: 'Ember', form: 0, mood: 82, equipped: {} }, 'h1'))
    const seen = (await changes($, clock, 10_000)).map((one) => one.text ?? '')
    expect(seen.length).toBeGreaterThan(1)
    expect(seen.some((text) => text.includes('◆') || text.includes('♪'))).toBe(false)
  })

  test('cheers while a level-up plays, arms up and sparkles by turns', async ($, on) => {
    const { clock, send } = await playing($, on, { petDisplay: { hidden: false, still: true } })
    await send(serverEvent('level.up', { from: 4, to: 5, tier: 'rare', glyph: '🗡️' }, 'l1'))
    const cheer = (await changes($, clock, 3_000)).map((one) => one.text)
    expect(cheer).toContain('\\ᓚᘏᗢ/ Ember ♥♥♥')
    expect(cheer).toContain('✧ᓚᘏᗢ✧ Ember ♥♥♥')
    expect(cheer.at(-1)).toBe(' ᓚᘏᗢ  Ember ♥♥♥')
  })

  test("fetches a prompt's drop: trots off the lane and comes back carrying it, in a few seconds", async ($, on) => {
    const { clock, send } = await playing($, on)
    await turn($, clock, () => send(graded(5, 'p1'), dropped('uncommon', 'p1')))
    // The drop's coin spins first; then the pet goes.
    const seen = await changes($, clock, 12_000)
    const texts = seen.map((one) => one.text)
    const gone = texts.findIndex((text) => faceAt(text) < 0)
    const carrying = texts.findIndex((text) => /ᓚᘏᗢ◆/.test(text ?? ''))
    expect(gone).toBeGreaterThan(0)
    expect(carrying).toBeGreaterThan(gone)
    const from = seen[gone]?.at ?? 0
    const last = seen.findLastIndex((one) => (one.text ?? '').includes('◆'))
    expect((seen[last + 1]?.at ?? 0) - from).toBeLessThan(4_000)
  })

  const napping = 'falls asleep after 10 minutes with no prompt, holds still asleep, and wakes on the next prompt'
  test(napping, { timeoutMs: 20_000 }, async ($, on) => {
    const { clock } = await playing($, on, { petDisplay: { hidden: false, still: true } })
    await clock.advance(9 * 60_000)
    expect(await petText($)).not.toContain('z z')
    await clock.advance(61_000)
    const asleep = await petText($)
    expect(asleep).toMatch(/ᓚᘏᗢ z z Ember ♥♥♥$/)
    // Asleep, nothing moves, so nothing is drawn.
    expect((await changes($, clock, 20_000)).map((one) => one.text)).toEqual([asleep])
    await $.prompt.submit({ text: 'what next', wait: false, origin: composer })
    await clock.settle()
    expect(await petText($)).not.toContain('z')
  })
})

describe('the player chooses', () => {
  test('/pathofdev pet still keeps it in place, hide takes it off, show and move bring it back', async ($, on) => {
    const { clock } = await playing($, on)
    const run = async (args: string) =>
      (await $.command.run({ command: 'pathofdev', args, origin: composer, presentation })).text
    expect(await run('pet')).toMatch(/^Ember wanders the band\./)
    expect(await run('pet still')).toMatch(/^Ember sits still on the band, and still reacts to your work\./)
    expect((await changes($, clock, 10_000)).map((one) => one.text)).toEqual([' ᓚᘏᗢ  Ember ♥♥♥'])
    expect(await run('pet hide')).toMatch(/^Ember is off the band; its mood and XP bonus stay\./)
    expect(await petText($)).toBeNull()
    // The row's other pieces keep their place without it.
    expect(await run('pet show')).toMatch(/^Ember sits still on the band/)
    expect(await petText($)).toBe(' ᓚᘏᗢ  Ember ♥♥♥')
    expect(await run('pet hide')).toMatch(/off the band/)
    expect(await run('pet move')).toMatch(/^Ember wanders the band\./)
    expect((await changes($, clock, 20_000)).length).toBeGreaterThan(3)
    expect(await run('pet dance')).toBe('The pet on the band: /pathofdev pet | still | move | hide | show | tip.')
  })

  test('the choice is kept in the store, so a reload and a new session find it', async ($, on) => {
    const { clock } = await playing($, on)
    await $.command.run({ command: 'pathofdev', args: 'pet hide', origin: composer, presentation })
    await $.session.start(start)
    await clock.settle()
    expect(await petText($)).toBeNull()
    expect(displayOf({ hidden: true, still: false })).toEqual({ hidden: true, still: false })
  })

  test('a new session reads the choice the store kept', async ($, on) => {
    await playing($, on, { petDisplay: { hidden: true, still: true } })
    expect(await petText($)).toBeNull()
  })

  test("the pet's card in the pane has the same toggles", async ($, on) => {
    const { clock } = await playing($, on)
    await $.command.run({ command: 'pathofdev', args: '', origin: composer, presentation })
    const pane = await $.ui.mount({
      plugin: 'pathofdev',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'pathofdev',
      props: {
        title: 'Path of Dev',
        isFocused: true,
        bodyColumns: 90,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 40 },
        view: {},
      },
    })
    expect(await pane.find({ type: 'Text', text: 'Wandering the band' })).toBeDefined()
    await pane.press({ key: 'pet:still' })
    expect(await pane.find({ type: 'Text', text: 'Sitting still on the band' })).toBeDefined()
    expect(await petText($)).toBe(' ᓚᘏᗢ  Ember ♥♥♥')
    await pane.press({ key: 'pet:hide' })
    expect(await pane.find({ type: 'Button', key: 'pet:move' })).toBeUndefined()
    expect(await petText($)).toBeNull()
    await pane.press({ key: 'pet:show' })
    await pane.press({ key: 'pet:move' })
    await pane.unmount()
    expect((await changes($, clock, 20_000)).length).toBeGreaterThan(3)
  })
})

describe('reduced motion and none', () => {
  for (const animations of ['reduced', 'off']) {
    const still = `${animations}: the pet never wanders; a reaction is one still frame`
    test(still, { options: { animations } }, async ($, on) => {
      const { clock, send } = await playing($, on)
      expect((await changes($, clock, 10_000)).map((one) => one.text)).toEqual([' ᓚᘏᗢ  Ember ♥♥♥'])
      await send(serverEvent('pet.petted', { mood: 95, gained: 5 }, 'f2'))
      expect((await changes($, clock, 3_000)).map((one) => one.text)).toEqual([' ᓚᘏᗢ♥ Ember ♥♥♥', ' ᓚᘏᗢ  Ember ♥♥♥'])
    })
  }

  const off = { options: { animations: 'off' } }
  test('off: a level-up, which plays no celebration, shows one still cheer', off, async ($, on) => {
    const { clock, send } = await playing($, on)
    await send(serverEvent('level.up', { from: 4, to: 5, tier: 'rare', glyph: '🗡️' }, 'l1'))
    expect((await changes($, clock, 4_000)).map((one) => one.text)).toEqual(['\\ᓚᘏᗢ/ Ember ♥♥♥', ' ᓚᘏᗢ  Ember ♥♥♥'])
  })
})

// Haiku's replies: a good prompt that never says when it is done, its note the tip; and a weak one.
const goodReply = JSON.stringify({
  clarity: 9,
  grammar: 9,
  specificity: 9,
  instructive: 8,
  context: 8,
  doneCriteria: 4,
  focus: 9,
  regret: 1,
  note: 'Say which test should pass.',
})
const weakReply = JSON.stringify({
  clarity: 4,
  grammar: 8,
  specificity: 3,
  instructive: 4,
  context: 2,
  doneCriteria: 2,
  focus: 6,
  regret: 0,
  note: 'Name the file and the error.',
})
// By rubric 2, against a server that prices it: a good prompt that never says what a good outcome looks like.
const goodReplyV2 = JSON.stringify({
  kind: 'task',
  intent: 9,
  grounding: 10,
  why: 8,
  successShape: 4,
  scope: 9,
  forward: 8,
  craft: 7,
  misspelled: [],
  tone: 6,
  note: 'Say which test should pass.',
})
const v2Rules = { ...careRules, prompt: { rubricVersion: 2, v2: { maxXp: 15 } } }
const still = { petDisplay: { hidden: false, still: true } }
const praised = '“Ember loves that you named the exact spot!”'
const tipped = '“Say which test should pass.”'

/** The ids of the prompt.graded events the mod sent: the cause the server names on the XP each earned. */
const gradedIds = (sent: ReadonlyArray<Sent>): Array<string> =>
  sent.flatMap((one) => {
    const { body } = one
    if (one.path !== '/v1/events' || typeof body !== 'object' || body === null || !('events' in body)) return []
    const events: unknown = body.events
    return Array.isArray(events)
      ? events.flatMap((event: unknown) =>
          typeof event === 'object' && event !== null && 'type' in event && event.type === 'prompt.graded' &&
          'id' in event && typeof event.id === 'string'
            ? [event.id]
            : [],
        )
      : []
  })

/** A turn whose prompt Haiku graded; once the queue is sent, the stream brings the XP it earned, at `grade`. */
const gradedTurn = async (
  $: Dollar,
  clock: Clock,
  sent: ReadonlyArray<Sent>,
  send: (...events: Array<{ seq: number }>) => Promise<void>,
  grade: number,
) => {
  const before = gradedIds(sent).length
  await turn($, clock)
  await clock.advance(30_000)
  await until(clock, () => gradedIds(sent).length > before)
  await send(graded(grade, gradedIds(sent).at(-1) ?? ''))
}

const run = async ($: Dollar, args: string) =>
  (await $.command.run({ command: 'pathofdev', args, origin: composer, presentation })).text

describe('the pet coach', () => {
  test('after a good prompt it hops first, then says praise and a tip beside itself, for about 8 s', async ($, on) => {
    const { clock, send, sent } = await playing($, on, still, ember, { pet: ember }, goodReply)
    const sitting = await petText($)
    await gradedTurn($, clock, sent, send, 8)
    const seen = await changes($, clock, 16_000)
    const texts = seen.map((one) => one.text ?? '')
    const hop = texts.findIndex((text) => text.includes('♪'))
    const praise = texts.findIndex((text) => text.includes(praised))
    expect(hop).toBeGreaterThanOrEqual(0)
    expect(praise).toBeGreaterThan(hop)
    expect(texts[praise]).toBe(` ${praised} ᓚᘏᗢ  Ember ♥♥♥`)
    expect(texts[praise + 1]).toBe(` ${tipped} ᓚᘏᗢ  Ember ♥♥♥`)
    expect(texts[praise + 2]).toBe(sitting)
    const shown = (seen[praise + 2]?.at ?? 0) - (seen[praise]?.at ?? 0)
    expect(shown).toBeGreaterThanOrEqual(7_750)
    expect(shown).toBeLessThanOrEqual(8_250)
  })

  test('by rubric 2 it hops and speaks unasked from 8, and a 7.5 that would by rubric 1 earns nothing', async ($, on) => {
    const { clock, send, sent } = await playing($, on, still, ember, { pet: ember }, goodReplyV2, v2Rules)
    const sitting = await petText($)
    await gradedTurn($, clock, sent, send, 7.5)
    expect((await changes($, clock, 16_000)).map((one) => one.text)).toEqual([sitting])
    await gradedTurn($, clock, sent, send, 8)
    const texts = (await changes($, clock, 16_000)).map((one) => one.text ?? '')
    const hop = texts.findIndex((text) => text.includes('♪'))
    const praise = texts.findIndex((text) => text.includes('“Ember loves that you named the exact spot!”'))
    expect(hop).toBeGreaterThanOrEqual(0)
    expect(praise).toBeGreaterThan(hop)
    expect(texts[praise + 1]).toBe(` ${tipped} ᓚᘏᗢ  Ember ♥♥♥`)
  })

  test('the gain line steps aside while the pet speaks, lending the bubble its room, and comes back', async ($, on) => {
    const { clock, send, sent } = await playing($, on, still, ember, { pet: ember }, goodReply)
    await gradedTurn($, clock, sent, send, 9)
    const gainShown = async () => {
      const ui = await mountBand($)
      const texts = (await ui.findAll({ type: 'Text' })).map((one) => one.text)
      await ui.unmount()
      return texts.some((text) => text.includes('XP ·'))
    }
    expect(await gainShown()).toBe(true)
    for (let round = 0; round < 40 && !((await petText($)) ?? '').includes('“'); round++) await clock.advance(250)
    expect(await petText($)).toContain(praised)
    expect(await gainShown()).toBe(false)
    await clock.advance(8_000)
    expect(await petText($)).not.toContain('“')
    expect(await gainShown()).toBe(true)
  })

  test('a wandering pet holds still while it speaks, and wanders on after', async ($, on) => {
    const { clock, send, sent } = await playing($, on, {}, ember, { pet: ember }, goodReply)
    await gradedTurn($, clock, sent, send, 9)
    const seen = await changes($, clock, 20_000)
    const speaking = seen.filter((one) => (one.text ?? '').includes('“'))
    expect(speaking).toHaveLength(2)
    expect(new Set(speaking.map((one) => faceAt(one.text?.replace(/“[^”]*”/, '') ?? null))).size).toBe(1)
    // Once the bubble is down, it is up and about again: it turns or walks.
    const after = seen.slice(seen.findLastIndex((one) => (one.text ?? '').includes('“')) + 1)
    expect(after.length).toBeGreaterThan(1)
  })

  test('after a weak prompt it stays quiet by default, and is never drawn sad', async ($, on) => {
    const { clock, send, sent } = await playing($, on, still, ember, { pet: ember }, weakReply)
    const sitting = await petText($)
    await gradedTurn($, clock, sent, send, 3.6)
    expect((await changes($, clock, 15_000)).map((one) => one.text)).toEqual([sitting])
  })

  const always = { options: { coach: 'always' } }
  test('coach always: after a weak prompt, a gentle tip and no praise', always, async ($, on) => {
    const { clock, send, sent } = await playing($, on, still, ember, { pet: ember }, weakReply)
    await gradedTurn($, clock, sent, send, 3.6)
    const texts = (await changes($, clock, 15_000)).map((one) => one.text ?? '')
    expect(texts.filter((text) => text.includes('“'))).toEqual([' “Name the file and the error.” ᓚᘏᗢ  Ember ♥♥♥'])
  })

  const off = { options: { coach: 'off' } }
  test('coach off: it says nothing unasked, and /pathofdev pet tip still shows the tip', off, async ($, on) => {
    const { clock, send, sent } = await playing($, on, still, ember, { pet: ember }, goodReply)
    await gradedTurn($, clock, sent, send, 9)
    const quiet = (await changes($, clock, 15_000)).map((one) => one.text ?? '')
    expect(quiet.some((text) => text.includes('“'))).toBe(false)
    expect(await run($, 'pet tip')).toBe('Ember says it beside itself on the band.')
    const texts = (await changes($, clock, 10_000)).map((one) => one.text ?? '')
    expect(texts.filter((text) => text.includes('“'))).toEqual([
      ` ${praised} ᓚᘏᗢ  Ember ♥♥♥`,
      ` ${tipped} ᓚᘏᗢ  Ember ♥♥♥`,
    ])
  })

  test('says something unasked at most once in 3 graded prompts', async ($, on) => {
    const { clock, send, sent } = await playing($, on, still, ember, { pet: ember }, goodReply)
    const bubbles = async () =>
      (await changes($, clock, 15_000)).filter((one) => (one.text ?? '').includes('“')).length
    await gradedTurn($, clock, sent, send, 9)
    expect(await bubbles()).toBe(2)
    await gradedTurn($, clock, sent, send, 9)
    expect(await bubbles()).toBe(0)
  })

  test('a bubble a new turn took down before it showed costs nothing: the next good prompt speaks', async ($, on) => {
    const { clock, send, sent } = await playing($, on, still, ember, { pet: ember }, goodReply)
    const bubbles = async () =>
      (await changes($, clock, 15_000)).filter((one) => (one.text ?? '').includes('“')).length
    await gradedTurn($, clock, sent, send, 9)
    // The XP's shimmer still plays, and the hop waits: the player starts the next turn before the pet can speak.
    await $.turn.start({ text: 'and the empty case', turnId: 't2' })
    await $.turn.complete({ answer: 'Done', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
    expect(await bubbles()).toBe(0)
    await gradedTurn($, clock, sent, send, 9)
    expect(await bubbles()).toBe(2)
  })

  test('with no room on the band for a bubble, it says nothing and counts nothing', async ($, on) => {
    const { clock, send, sent } = await playing($, on, still, ember, { pet: ember }, goodReply)
    const narrow = await $.ui.mount({
      plugin: 'pathofdev',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { ...bandProps(), bodyColumns: 50 },
    })
    await gradedTurn($, clock, sent, send, 9)
    for (let at = 0; at < 15_000; at += 250) {
      expect((await narrow.findAll({ type: 'Text' })).some((one) => one.text.includes('“'))).toBe(false)
      await clock.advance(250)
    }
    await narrow.unmount()
    // Wide again, the next good prompt speaks: the one with no room cost nothing.
    await petText($)
    await gradedTurn($, clock, sent, send, 9)
    const texts = (await changes($, clock, 15_000)).map((one) => one.text ?? '')
    expect(texts.filter((text) => text.includes('“'))).toHaveLength(2)
  })

  test('pet tip answers here when the pet is hidden, still an egg, or nothing was graded yet', async ($, on) => {
    const hatchery: { pet: unknown } = { pet: null }
    const { clock, send, sent } = await playing($, on, {}, null, hatchery, goodReply)
    expect(await run($, 'pet tip')).toBe('Your pet has no tip yet: ask again after a prompt you type is graded.')
    await gradedTurn($, clock, sent, send, 9)
    // An egg says nothing on the band: the tip is the reply.
    expect(await run($, 'pet tip')).toBe('Your pet loves that you named the exact spot! Say which test should pass.')
    expect(await petText($)).toBeNull()
  })

  test('pet tip answers here, whole, when the pet is off the band', async ($, on) => {
    const { clock, send, sent } = await playing($, on, still, ember, { pet: ember }, weakReply)
    await gradedTurn($, clock, sent, send, 3.6)
    await run($, 'pet hide')
    expect(await run($, 'pet tip')).toBe('Name the file and the error.')
    expect(await petText($)).toBeNull()
  })

  test('a reaction takes the bubble down and plays at once; a new turn takes it down too', async ($, on) => {
    const { clock, send, sent } = await playing($, on, still, ember, { pet: ember }, goodReply)
    await gradedTurn($, clock, sent, send, 3.6)
    // The XP's shimmer plays first.
    await clock.advance(5_000)
    await run($, 'pet tip')
    await clock.settle()
    expect(await petText($)).toContain('“')
    await send(serverEvent('pet.petted', { mood: 95, gained: 5 }, 'f1'))
    expect(await petText($)).toMatch(/^ ᓚᘏᗢ[♥♡] Ember ♥♥♥$/)
    await clock.advance(5_000)
    await run($, 'pet tip')
    await clock.settle()
    expect(await petText($)).toContain('“')
    await $.turn.start({ text: 'next', turnId: 't2' })
    await clock.settle()
    expect(await petText($)).not.toContain('“')
  })

  test('a reload takes the bubble down at its time', async ($, on) => {
    const { clock, send, sent } = await playing($, on, still, ember, { pet: ember }, weakReply)
    await gradedTurn($, clock, sent, send, 3.6)
    await clock.advance(5_000)
    await run($, 'pet tip')
    await clock.settle()
    await $.session.start(start)
    await clock.settle()
    expect(await petText($)).toContain('“')
    await clock.advance(8_000)
    expect(await petText($)).toBe(' ᓚᘏᗢ  Ember ♥♥♥')
  })

  const noMotion = { options: { animations: 'off' } }
  test('with celebrations off, the bubble still shows, after one still hop', noMotion, async ($, on) => {
    const { clock, send, sent } = await playing($, on, {}, ember, { pet: ember }, goodReply)
    await gradedTurn($, clock, sent, send, 9)
    const texts = (await changes($, clock, 15_000)).map((one) => one.text ?? '')
    expect(texts).toEqual([
      '✧ᓚᘏᗢ✧ Ember ♥♥♥',
      ` ${praised} ᓚᘏᗢ  Ember ♥♥♥`,
      ` ${tipped} ᓚᘏᗢ  Ember ♥♥♥`,
      ' ᓚᘏᗢ  Ember ♥♥♥',
    ])
  })
})

// The pieces, as plain values.

/** A prompt's XP as the stream carries it, priced at `grade`; an older server's names none. */
const grant = (grade?: number): ServerEvent => ({
  seq: 1,
  at: '2026-10-09T08:00:00.000Z',
  cause: '01K6ZQ8W3J0000000000000P01',
  type: 'xp.granted',
  data: {
    amount: 12,
    tier: 'reported',
    reason: 'prompt.graded',
    totalAfter: 150,
    ...(grade === undefined ? {} : { grade }),
  },
})

const pose = (more: Partial<PetPose> = {}): PetPose => ({
  away: 0,
  facing: 'right',
  look: 'idle',
  back: null,
  front: null,
  isAway: false,
  ...more,
})

const context = (more: Partial<StepContext> = {}): StepContext => ({
  wanders: true,
  animates: true,
  free: true,
  sleepy: false,
  room: 11,
  ...more,
})

/** Steps the walker `count` times, keeping each step's pose and wait. */
const walk = (from: Walker, count: number, at: StepContext = context()) => {
  const steps: Array<{ pose: PetPose; waitMs: number | null }> = []
  let walker = from
  for (let i = 0; i < count; i++) {
    const step = stepWalker(walker, at)
    walker = step.walker
    steps.push({ pose: poseOf(walker, at), waitMs: step.waitMs })
  }
  return { steps, walker }
}

describe('the lane', () => {
  test('is exactly its width, the pet at its right end or `away` cells left of it, never past the edge', () => {
    const face = faceOf(ember, 'idle', 'right')
    for (let away = 0; away < 20; away++) {
      const row = laneRow(face, pose({ away }), 16)
      expect(cellsOfRow(row)).toBe(16)
      expect(faceAt(row.map((run) => run.text).join(''))).toBe(Math.max(1, 12 - away))
    }
    expect(laneRow(face, pose({ isAway: true }), 16).map((run) => run.text).join('')).toBe(' '.repeat(16))
  })

  test('holds a text beside the pet, after it when there is room, else before it: the coach seam', () => {
    const face = faceOf(ember, 'idle', 'right')
    const tip = [{ text: 'name the file' }]
    const lane = laneWidthOf(face, pose(), true, 80, tip)
    expect(lane).toBe(Math.max(wanderLane, cellsOf(face) + 2 + cellsOf('name the file') + 1))
    const near = laneRow(face, pose({ away: 0 }), lane, tip).map((run) => run.text).join('')
    expect(near).toMatch(/name the file ᓚᘏᗢ $/)
    const far = laneRow(face, pose({ away: lane }), lane, tip).map((run) => run.text).join('')
    expect(far).toMatch(/^ ᓚᘏᗢ name the file/)
    // Still, the lane is just the face and its marks, wider by the text.
    expect(laneWidthOf(face, pose(), false, 80, tip)).toBe(cellsOf(face) + 2 + cellsOf('name the file') + 1)
    // With no room to spare, a wandering pet's lane is as narrow as a still one's.
    expect(laneWidthOf(face, pose(), true, 3, null)).toBe(cellsOf(face) + 2)
  })

  test("is the pet's whole piece of the row with its name and hearts, or nothing once the player hid it", () => {
    const scene = { pose: pose(), display: { hidden: false, still: true }, activeAt: 0 }
    expect(petRowOf(ember, scene, '♥♥♥', 'full', null, 80)?.row.map((run) => run.text).join('')).toBe(' ᓚᘏᗢ  Ember ♥♥♥')
    expect(petRowOf(ember, { ...scene, display: { hidden: true, still: true } }, '♥♥♥', 'full', null, 80)).toBeNull()
  })

  test('draws each species its own way, turning the fox around, never with a sad face', () => {
    expect(faceOf(ember, 'idle', 'left')).toBe('ᗢᘏᓗ')
    expect(faceOf({ species: 'slime', form: 0 }, 'happy', 'right')).toBe('(^ᴗ^)')
    expect(faceOf({ species: 'robot', form: 2 }, 'asleep', 'left')).toBe('✧[-_-]✧')
    expect(faceOf({ species: 'dragon', form: 0 }, 'idle', 'right')).toBe('ᓚᘏᗢ')
    const looks: ReadonlyArray<PetLook> = ['idle', 'happy', 'chew', 'asleep']
    for (const species of ['fox', 'slime', 'robot', 'owl'])
      for (const look of looks)
        expect(faceOf({ species, form: 0 }, look, 'right')).not.toMatch(/[;╥TㅠಥᴖQ]|\(\s*[´`]/)
  })
})

describe('the walker', () => {
  test('wanders inside its room, a step every half second at the quickest, resting with nothing new to draw', () => {
    const { steps } = walk(homeWalker, 400)
    const aways = steps.map((one) => one.pose.away)
    expect(Math.min(...aways)).toBe(0)
    expect(Math.max(...aways)).toBeLessThanOrEqual(11)
    expect(new Set(aways).size).toBeGreaterThan(5)
    expect(steps.every((one) => one.waitMs !== null && one.waitMs >= 500)).toBe(true)
    // A long rest follows a step that changed nothing: a sit draws nothing.
    const rests = steps.filter((one, i) => i > 0 && JSON.stringify(one.pose) === JSON.stringify(steps[i - 1]?.pose))
    expect(rests.length).toBeGreaterThan(0)
    expect(rests.every((one) => (one.waitMs ?? 0) >= 1_500)).toBe(true)
  })

  test('a sleepy mood rests longer, and is drawn no different', () => {
    const awake = walk(homeWalker, 200).steps
    const sleepy = walk(homeWalker, 200, context({ sleepy: true })).steps
    const total = (steps: typeof awake) => steps.reduce((sum, one) => sum + (one.waitMs ?? 0), 0)
    expect(total(sleepy)).toBeGreaterThan(total(awake))
    expect(sleepy.every((one) => one.pose.look === 'idle')).toBe(true)
  })

  test('still, or held by a turn, it takes no steps of its own', () => {
    expect(stepWalker(homeWalker, context({ wanders: false })).waitMs).toBeNull()
    expect(stepWalker(homeWalker, context({ free: false })).waitMs).toBeNull()
  })

  test('a reaction a turn cuts short plays again, whole, once the band is free', () => {
    const hop: Reaction = { kind: 'hop' }
    const started = stepWalker(withReactions(homeWalker, [hop]), context({ wanders: false })).walker
    expect(started.act?.reaction).toEqual(hop)
    const held = stepWalker(started, context({ free: false })).walker
    expect(held.act).toBeNull()
    expect(held.queue).toEqual([hop])
  })

  test('stilled or hidden, it keeps the reactions waiting for the band, the one it was playing first', () => {
    const hop: Reaction = { kind: 'hop' }
    const pat: Reaction = { kind: 'pat' }
    const playing = stepWalker(withReactions(homeWalker, [hop, pat]), context()).walker
    expect(playing.act?.reaction).toEqual(hop)
    expect(settledWalker({ ...playing, away: 4 })).toMatchObject({ away: 0, act: null, queue: [hop, pat] })
  })

  test('after a reload, before the band draws, it stays where it stood instead of snapping home', () => {
    const scene = { pose: pose({ away: 10, facing: 'left' }), display: { hidden: false, still: false }, activeAt: 0 }
    const kept = walkerOf(scene, { wanders: true, animates: true })
    expect(kept.away).toBe(10)
    const next = stepWalker(kept, context({ room: roomNow(null, kept) })).walker
    expect(next.away).toBeGreaterThanOrEqual(9)
    // Once the band has drawn, its lane is the room.
    expect(roomNow(6, kept)).toBe(6)
  })

  test("a fetch goes off the lane's far end and comes back to where it began, in under five seconds", () => {
    const item = { text: '◆', color: '#5fd75f' }
    const from: Walker = { ...homeWalker, away: 3 }
    let walker = withReactions(from, [{ kind: 'fetch', item }])
    let spent = 0
    const seen: Array<PetPose> = []
    do {
      const step = stepWalker(walker, context())
      walker = step.walker
      seen.push(poseOf(walker, context()))
      // Until the last frame of the fetch is done: what the pet does after it is its own.
      if (walker.act !== null) spent += step.waitMs ?? 0
    } while (walker.act !== null && spent < 20_000)
    expect(seen.some((one) => one.isAway)).toBe(true)
    expect(seen.some((one) => one.front === item && one.away === 11)).toBe(true)
    expect(walker.away).toBe(3)
    expect(spent).toBeLessThan(5_000)
  })

  test('/pathofdev pet reads still, move, hide and show, and anything else as the usage', () => {
    expect(petAskOf('pet')).toEqual({ kind: 'view' })
    expect(petAskOf('  pet   still ')).toEqual({ kind: 'still' })
    expect(petAskOf('pet hide now')).toMatch(/^The pet on the band/)
    expect(petAskOf('profile hide pet')).toBeNull()
    const hidden = displayAfter({ kind: 'hide' }, { hidden: false, still: true })
    expect(hidden).toEqual({ hidden: true, still: true })
    expect(displayAfter({ kind: 'show' }, hidden)).toEqual({ hidden: false, still: true })
    expect(displayAfter({ kind: 'move' }, hidden)).toEqual({ hidden: false, still: false })
    expect(displayOf('garbage')).toEqual({ hidden: false, still: false })
  })
})
