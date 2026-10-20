import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On, PromptOrigin, RenderPropsOf, SessionStartInput } from 'claude-code'
import type { BandView, MissionsView, MissionView, StatusFacts } from '../types'
import { bandModeOf, holdMs, isBandShown, isHeld, kicked, openingAfter } from './collapse'
import { gradeSegment, statusText } from './status'
import type { Moments } from './collapse'
import { runningCount } from './missions'

// The band as the `band` option has it: shut at rest in `auto` and open for a moment of play, always open in `full`,
// never in `line`; and the status line under the prompt beside it. A small server beneath the mod hands it a hatched
// pet and the stream's events, and the engine beneath draws a band of its own wherever the mod's passes.

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

const snapshot = {
  serverId: 'local-test',
  streamEpoch: 1,
  cursor: 0,
  pet: ember,
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
}

const reply = (status: number, body: unknown) => ({
  value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) },
})

/**
 * What the world beneath holds: no server when it is `down`, Haiku's reply when there is a `grader`, and the
 * missions its snapshot carries, with the rules that say the server knows them.
 */
type More = { down?: boolean; grader?: string; quests?: ReadonlyArray<unknown> }

const missionRules = {
  missions: { daily: { count: 3, tier: 'uncommon' }, weekly: { offered: 5, active: 3, tier: 'rare' } },
}

/**
 * The engine beneath the mod, with what the status line was sent, the band's site and the ids of the prompts graded,
 * and a local server that answers its routes and hands the stream the test's events.
 */
const world = (on: On, clock: Clock, stream: Array<{ seq: number }>, more: More = {}) => {
  const statuses: Array<string | undefined> = []
  const gradedIds: Array<string> = []
  const site = { requestId: '' }
  on('ui.toast', () => ({ value: undefined }))
  on('ui.focus', () => ({}))
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    site.requestId = e.requestId
    return $.ui.resolve(e).Box({})
  })
  on('ui.render', { component: 'PromptHint' }, ($, e) =>
    $.ui.resolve(e).Text({ dimColor: true, children: e.props.hint }),
  )
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
  on('model.complete', () => {
    if (more.grader === undefined) throw new Error('no model here')
    const usage = { input_tokens: 812, output_tokens: 41, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    return { value: { isAnswered: true, text: more.grader, usage } }
  })
  on('process.run', () => ({
    value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('http.fetch', async ($, e) => {
    if (more.down === true) throw new Error('connect ENOENT /home/player/.pathofdev/server.sock')
    const url = new URL(e.url)
    if (e.init?.method === 'DELETE') return reply(200, { closed: true })
    if (url.pathname === '/v1/sessions') {
      const shot = more.quests === undefined ? snapshot : { ...snapshot, quests: more.quests }
      const rules = more.quests === undefined ? careRules : { ...careRules, ...missionRules }
      return reply(200, { snapshot: shot, rules, minClientVersion: '0.0.0', acceptedEventTypes: [] })
    }
    if (url.pathname === '/v1/events') {
      const body: unknown = e.init?.body === undefined ? undefined : JSON.parse(e.init.body)
      const events: unknown = typeof body === 'object' && body !== null && 'events' in body ? body.events : []
      const ids = (Array.isArray(events) ? events : []).flatMap((event: unknown) =>
        typeof event === 'object' && event !== null && 'id' in event && typeof event.id === 'string'
          ? [{ id: event.id, isGraded: 'type' in event && event.type === 'prompt.graded' }]
          : [],
      )
      gradedIds.push(...ids.filter((one) => one.isGraded).map((one) => one.id))
      return reply(200, { results: ids.map((one) => ({ id: one.id, status: 'accepted' })), events: [] })
    }
    if (url.pathname === '/v1/commands') return reply(200, { status: 'ok', events: [] })
    for (let waited = 0; waited < 25_000 && stream.length === 0; waited += 1_000) await clock.sleep(1_000)
    const events = stream.splice(0)
    const cursor = Math.max(0, ...events.map((event) => event.seq))
    return reply(200, { events, cursor, rulesVersion: 1, minClientVersion: '0.0.0' })
  })
  return { statuses, site, gradedIds }
}

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

/** A session with the pet hatched and the stream open; `send` hands the mod events. */
const playing = async ($: Dollar, on: On, store: Record<string, unknown> = {}, more: More = {}) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-09T08:00:00Z') })
  mock.store(on, { explored: ['acme/widgets'], ...store })
  mock.env(on, { HOME: '/home/player' })
  const stream: Array<{ seq: number }> = []
  const { statuses, site, gradedIds } = world(on, clock, stream, more)
  await $.session.start(start)
  await until(clock, () => statuses.at(-1)?.startsWith('⚔ Lv') === true)
  await clock.settle()
  const send = async (...events: Array<{ seq: number }>) => {
    stream.push(...events)
    await clock.advance(1_000)
    await until(clock, () => stream.length === 0)
    await clock.settle()
  }
  return { clock, send, statuses, site, gradedIds }
}

const hintProps = (isWorking = false, isDraft = false): RenderPropsOf['PromptHint'] => ({
  isDraft,
  isWorking,
  hint: '? for shortcuts',
})

/**
 * What the prompt hint draws on `surface`, `columns` wide: whether the engine's own line is there, and the status
 * line's row under it (null where it draws none) with its runs, each as its text and props.
 */
const hintNow = async ($: Dollar, surface: 'terminal' | 'desktop' = 'terminal', props = hintProps(), columns = 100) => {
  const viewport = { columns, rows: 40 }
  const ui = await $.ui.mount({ plugin: 'pathofdev', surface, component: 'PromptHint', props, viewport })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  const engine = texts.some((one) => one.text === '? for shortcuts')
  // The row is the one Text cut at its end; its runs are the Texts in it.
  const row = texts.find((one) => one.props['wrap'] === 'truncate')
  const runs = row === undefined ? [] : texts.filter((one) => one !== row && one.text !== '? for shortcuts')
  return { engine, status: row === undefined ? null : row.text, runs: runs.filter((one) => one.text.trim() !== '') }
}

/** The props of the run that reads `text` in the status row. */
const runOf = (runs: ReadonlyArray<{ text: string; props: Record<string, unknown> }>, text: string) =>
  runs.find((one) => one.text === text)?.props

const mountBand = ($: Dollar, isWorking = false) =>
  $.ui.mount({ plugin: 'pathofdev', surface: 'terminal', component: 'AbovePrompt', props: bandProps(isWorking) })

/** What the band draws now: null while it is shut, else its texts, one a line. */
const bandNow = async ($: Dollar, isWorking = false): Promise<string | null> => {
  const ui = await mountBand($, isWorking)
  const texts = (await ui.findAll({ type: 'Text' })).map((one) => one.text)
  await ui.unmount()
  return texts.length === 0 ? null : texts.join('\n')
}

/** Watches the band for `ms`, a look every 250 ms: when it was open, as runs of [from, to). */
const openRuns = async ($: Dollar, clock: Clock, ms: number) => {
  const runs: Array<{ from: number; to: number }> = []
  for (let at = 0; at < ms; at += 250) {
    const now = clock.now()
    if ((await bandNow($)) !== null) {
      const last = runs.at(-1)
      if (last !== undefined && last.to === now) last.to = now + 250
      else runs.push({ from: now, to: now + 250 })
    }
    await clock.advance(250)
  }
  return runs
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

const run = async ($: Dollar, args: string) =>
  (await $.command.run({ command: 'pathofdev', args, origin: composer, presentation })).text

/** No celebrations: a weak grade's gain then holds the band open for nothing but its own `holdMs`. */
const still = { options: { animations: 'off' } }
/** And a coach with a tip after every graded prompt, weak ones too. */
const tipping = { options: { animations: 'off', coach: 'always' } }

/** Haiku's grade of a weak prompt, with a tip. */
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

/** A mission running as the snapshot carries it, its window ending at `expiresAt`. */
const mission = (cadence: string, expiresAt: string) => ({
  questId: `q-${cadence}`,
  packId: 'starter',
  title: 'Steady Voice',
  description: null,
  cadence,
  start: cadence === 'daily' ? 'auto' : 'pick',
  status: 'active',
  progress: 1,
  goal: 5,
  rewards: { xp: 50, gold: 30 },
  expiresAt,
})

describe('the band, auto', () => {
  test('is shut at rest; the status line says it connects, then the essentials', async ($, on) => {
    const { statuses } = await playing($, on)
    expect(statuses[0]).toBe('⚔ Path of Dev · connecting…')
    expect(statuses.at(-1)).toBe('⚔ Lv 4 ▰▱▱▱▱ 30/203 xp')
    expect(await bandNow($)).toBeNull()
  })

  test('a gain opens it with its line, shut holdMs after; the status line takes the grade', still, async ($, on) => {
    const { clock, send, statuses } = await playing($, on)
    await send(graded(5, 'p1'))
    expect(await bandNow($)).toContain('Lv 4')
    expect(statuses.at(-1)).toBe('⚔ Lv 4 ▰▱▱▱▱ 30/203 xp · last prompt 5.0')
    // The gain came during the second the send took.
    await clock.advance(holdMs - 1_100)
    expect(await bandNow($)).toContain('XP')
    await clock.advance(1_200)
    expect(await bandNow($)).toBeNull()
  })

  test('a celebration holds it open while it plays, the pet with it, in one run, then shuts', async ($, on) => {
    const { clock, send } = await playing($, on)
    await send(dropped('rare', 'p1'), graded(9, 'p1'))
    const drawn = await bandNow($)
    expect(drawn).toContain('Ember')
    const runs = await openRuns($, clock, 40_000)
    // Open from the drop to holdMs past its moments, the celebration, the pet's fetch and hop, and never in between.
    expect(runs.length).toBe(1)
    expect(runs[0]?.to ?? 0).toBeLessThan(clock.now() - 5_000)
    expect((runs[0]?.to ?? 0) - (runs[0]?.from ?? 0)).toBeGreaterThan(holdMs)
  })

  test('a gain during a turn opens it once the turn is over', still, async ($, on) => {
    const { clock, send } = await playing($, on)
    await $.prompt.submit({ text: 'fix the parser so it reads nested lists', wait: false, origin: composer })
    await $.turn.start({ text: 'fix the parser', turnId: 't1' })
    await send(graded(5, 'p1'))
    expect(await bandNow($, true)).toBeNull()
    await clock.advance(holdMs)
    expect(await bandNow($, true)).toBeNull()
    await $.turn.complete({ answer: 'Done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.settle()
    expect(await bandNow($)).toContain('XP')
    await clock.advance(holdMs + 100)
    expect(await bandNow($)).toBeNull()
  })

  test('a reload keeps it open to its time, and shuts it then', still, async ($, on) => {
    const { clock, send } = await playing($, on)
    await send(graded(5, 'p1'))
    await clock.advance(2_000)
    await $.session.start(start)
    await clock.settle()
    expect(await bandNow($)).toContain('XP')
    await clock.advance(holdMs - 2_000)
    expect(await bandNow($)).toBeNull()
  })

  /** Moves the band's focus ring onto the element keyed `element`, or off them all with none. */
  const focusOn = ($: Dollar, requestId: string, element?: string) =>
    $.ui.focus({
      component: 'AbovePrompt',
      requestId,
      ...(element === undefined ? {} : { plugin: 'pathofdev', element }),
      origin: { kind: 'person' },
    })

  for (const letGo of ['the ring moves off', 'a prompt'])
    test(`the focus on its pet holds it open, until ${letGo} lets it go`, still, async ($, on) => {
      const { clock, send, site } = await playing($, on)
      // The band's site, as the engine names it: its band drew while the mod's was shut.
      expect(await bandNow($)).toBeNull()
      await send(graded(5, 'p1'))
      expect(await focusOn($, site.requestId, 'band:pet')).toEqual({})
      await clock.advance(holdMs * 3)
      expect(await bandNow($)).toContain('Lv 4')
      if (letGo === 'a prompt') await $.prompt.submit({ text: 'what next', wait: false, origin: composer })
      else await focusOn($, site.requestId)
      await clock.settle()
      expect(await bandNow($)).toContain('Lv 4')
      await clock.advance(holdMs + 100)
      expect(await bandNow($)).toBeNull()
    })

  test("a hidden pet's reaction holds nothing: the gain's own time, then shut", still, async ($, on) => {
    const { clock, send } = await playing($, on, { petDisplay: { hidden: true, still: false } })
    await send(graded(9, 'p1'))
    expect(await bandNow($)).not.toContain('Ember')
    await clock.advance(holdMs + 100)
    expect(await bandNow($)).toBeNull()
  })

  // Review fix: a line waiting on a pet asleep held the band open with no end.
  test('a tip waiting on a pet that fell asleep in a long turn holds nothing', tipping, async ($, on) => {
    const { clock, send, gradedIds } = await playing($, on, {}, { grader: weakReply })
    await $.prompt.submit({ text: 'fix the parser so it reads nested lists', wait: false, origin: composer })
    await $.turn.start({ text: 'fix the parser', turnId: 't1' })
    // The turn runs past the pet's nap, and the prompt's XP comes back during it, with a tip to say.
    await clock.advance(11 * 60_000)
    await until(clock, () => gradedIds.length > 0)
    await send(graded(5, gradedIds.at(-1) ?? ''))
    await $.turn.complete({ answer: 'Done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.settle()
    expect(await bandNow($)).toContain('XP')
    await clock.advance(holdMs + 100)
    expect(await bandNow($)).toBeNull()
  })

  // Review fix: the missions running were counted only when the stream brought something.
  test('the status line stops counting a mission once its window ends, with nothing on the stream', async ($, on) => {
    const quests = [mission('daily', '2026-10-09T08:01:00.000Z'), mission('weekly', '2026-10-12T00:00:00.000Z')]
    const { clock, statuses } = await playing($, on, {}, { quests })
    expect(statuses.at(-1)).toBe('⚔ Lv 4 ▰▱▱▱▱ 30/203 xp · 2 missions')
    await clock.advance(2 * 60_000)
    expect(statuses.at(-1)).toBe('⚔ Lv 4 ▰▱▱▱▱ 30/203 xp · 1 mission')
  })

  test('the status line says what to do while the server is down', async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse('2026-10-09T08:00:00Z') })
    mock.store(on)
    mock.env(on, { HOME: '/home/player' })
    const { statuses } = world(on, clock, [], { down: true })
    await $.session.start(start)
    await until(clock, () => statuses.at(-1)?.includes('offline') === true)
    expect(statuses.at(-1)).toBe('⚔ Path of Dev · offline · start the server: pnpm --filter @pathofdev/server start')
    expect(await bandNow($)).toBeNull()
  })
})

describe('the status line in the prompt hint', () => {
  const plain = '⚔ Lv 4 ▰▱▱▱▱ 30/203 xp'

  test('draws under the engine\'s hint on the terminal, as wide as the row; the plain one clears', async ($, on) => {
    const { clock, statuses } = await playing($, on)
    expect(statuses.at(-1)).toBe(plain)
    const { engine, status, runs } = await hintNow($)
    expect(engine).toBe(true)
    // 96 cells: the row less the hint's own blank ends, the bar at its most.
    expect(status).toBe(`⚔ Lv 4 ${'▰'.repeat(9)}${'▱'.repeat(51)} 30/203 xp`)
    expect(runOf(runs, '⚔ Lv 4')).toMatchObject({ color: 'claude', bold: true })
    expect(runOf(runs, '▰'.repeat(9))).toMatchObject({ color: 'success' })
    expect(runOf(runs, '▱'.repeat(51))).toMatchObject({ dimColor: true })
    await clock.settle()
    expect(statuses.at(-1)).toBeUndefined()
  })

  test('stays clear of the plain one over a reload', async ($, on) => {
    const { clock, statuses } = await playing($, on)
    await hintNow($)
    await clock.settle()
    const from = statuses.length
    await $.session.start(start)
    await clock.advance(60_000)
    expect(statuses.slice(from).every((text) => text === undefined)).toBe(true)
  })

  test('the grade in its tone, its label dim, at the row\'s end; working or with a draft', still, async ($, on) => {
    const { send } = await playing($, on)
    await send(graded(9, 'p1'))
    const good = await hintNow($, 'terminal', hintProps(true, true))
    expect(good.engine).toBe(true)
    expect(good.status).toBe(`⚔ Lv 4 ${'▰'.repeat(9)}${'▱'.repeat(51)} 30/203 xp    last prompt 9.0`)
    expect(runOf(good.runs, 'last prompt ')).toMatchObject({ dimColor: true })
    expect(runOf(good.runs, '9.0')).toMatchObject({ color: 'success' })
    await send(graded(4.2, 'p2'))
    expect(runOf((await hintNow($)).runs, '4.2')).toMatchObject({ color: 'warning' })
    await send(graded(6, 'p3'))
    expect(runOf((await hintNow($)).runs, '6.0')).toEqual({})
  })

  test('the missions dim, between dim separators, and dropped first on a narrow row', still, async ($, on) => {
    const quests = [mission('daily', '2026-10-09T09:00:00Z'), mission('weekly', '2026-10-12T00:00:00Z')]
    const { send } = await playing($, on, {}, { quests })
    await send(graded(9, 'p1'))
    const wide = await hintNow($)
    expect(wide.status).toBe(`⚔ Lv 4 ${'▰'.repeat(7)}${'▱'.repeat(41)} 30/203 xp · 2 missions · last prompt 9.0`)
    expect(runOf(wide.runs, '2 missions')).toMatchObject({ dimColor: true })
    expect(runOf(wide.runs, ' · ')).toMatchObject({ dimColor: true })
    // 56 cells: the grade goes, as the bar would be under its least beside both.
    expect((await hintNow($, 'terminal', hintProps(), 60)).status).toBe(
      `⚔ Lv 4 ${'▰'.repeat(4)}${'▱'.repeat(22)} 30/203 xp · 2 missions`,
    )
    // 36 cells: both go, and the bar takes the room.
    const narrow = await hintNow($, 'terminal', hintProps(), 40)
    expect(narrow.status).toBe(`⚔ Lv 4 ${'▰'.repeat(3)}${'▱'.repeat(16)} 30/203 xp`)
  })

  test('offline, what to do in dim, the command to run standing out', async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse('2026-10-09T08:00:00Z') })
    mock.store(on)
    mock.env(on, { HOME: '/home/player' })
    world(on, clock, [], { down: true })
    await $.session.start(start)
    await until(clock, async () => ((await hintNow($)).status ?? '').includes('offline'))
    const { status, runs } = await hintNow($)
    expect(status).toBe('⚔ Path of Dev · offline · start the server: pnpm --filter @pathofdev/server start')
    expect(runOf(runs, 'start the server: ')).toMatchObject({ dimColor: true })
    expect(runOf(runs, 'pnpm --filter @pathofdev/server start')).toMatchObject({ color: 'suggestion' })
  })

  test('on the desktop the engine\'s hint alone, and the plain status line stays', async ($, on) => {
    const { clock, statuses } = await playing($, on)
    const { engine, status } = await hintNow($, 'desktop')
    expect(engine).toBe(true)
    expect(status).toBeNull()
    await clock.settle()
    expect(statuses.at(-1)).toBe(plain)
  })
})

describe('the band, line', () => {
  const line = { options: { band: 'line' } }

  test('never opens: no drop plays, the pet says nothing; the status line has the grade', line, async ($, on) => {
    const { clock, send, statuses } = await playing($, on)
    await send(dropped('rare', 'p1'), graded(9, 'p1'))
    expect(await openRuns($, clock, 20_000)).toEqual([])
    expect(statuses.at(-1)).toBe('⚔ Lv 4 ▰▱▱▱▱ 30/203 xp · last prompt 9.0')
    // The tip comes here, as the band has no pet to say it.
    expect(await run($, 'pet tip')).not.toContain('beside itself')
  })
})

describe('the band, full', () => {
  const full = { options: { band: 'full' } }

  test('is open at rest, as it always was, and draws no status line', full, async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse('2026-10-09T08:00:00Z') })
    mock.store(on, { explored: ['acme/widgets'] })
    mock.env(on, { HOME: '/home/player' })
    const { statuses } = world(on, clock, [])
    await $.session.start(start)
    await until(clock, async () => ((await bandNow($)) ?? '').includes('Lv 4'))
    expect(statuses.every((text) => text === undefined)).toBe(true)
    expect(await hintNow($)).toEqual({ engine: true, status: null, runs: [] })
  })
})

describe('the opening', () => {
  const none: Moments = { celebrates: false, reacts: false, speaks: false, isFocused: false }

  test('the option reads auto unless it says full or line', () => {
    expect(bandModeOf({})).toBe('auto')
    expect(bandModeOf({ band: 'full' })).toBe('full')
    expect(bandModeOf({ band: 'line' })).toBe('line')
    expect(bandModeOf({ band: 'sometimes' })).toBe('auto')
  })

  test('held while a moment lasts, open holdMs from its end, then shut', () => {
    expect(isHeld(none)).toBe(false)
    expect(isHeld({ ...none, speaks: true })).toBe(true)
    expect(openingAfter(null, false, 0)).toBeNull()
    const held = openingAfter(null, true, 0)
    expect(held).toEqual({ until: null })
    expect(openingAfter(held, true, 5_000)).toEqual({ until: null })
    const ending = openingAfter(held, false, 5_000)
    expect(ending).toEqual({ until: 5_000 + holdMs })
    expect(openingAfter(ending, false, 5_000 + holdMs - 1)).toEqual(ending)
    expect(openingAfter(ending, false, 5_000 + holdMs)).toBeNull()
  })

  test('a moment opens it holdMs from now, never shortening a longer opening or ending a held one', () => {
    expect(kicked(null, 1_000)).toEqual({ until: 1_000 + holdMs })
    expect(kicked({ until: 2_000 }, 1_000)).toEqual({ until: 1_000 + holdMs })
    expect(kicked({ until: 1_000 + holdMs * 2 }, 1_000)).toEqual({ until: 1_000 + holdMs * 2 })
    expect(kicked({ until: null }, 1_000)).toEqual({ until: null })
  })

  test('shows always in full, never in line, and in auto while open', () => {
    expect(isBandShown('full', false)).toBe(true)
    expect(isBandShown('line', true)).toBe(false)
    expect(isBandShown('auto', false)).toBe(false)
    expect(isBandShown('auto', true)).toBe(true)
  })
})

describe('the status line', () => {
  const view: BandView = {
    name: 'Player',
    level: 7,
    title: 'Journeyman',
    glyph: '🛡',
    xp: { total: 900, intoLevel: 340, forNextLevel: 500 },
    gold: 25,
    isDev: false,
    pet: { species: 'fox', name: 'Ember', form: 0, mood: 82 },
  }
  const hint = { say: 'sign in with ', command: '/pathofdev login' }
  const facts: StatusFacts = { link: 'online', view, hint, running: 2, grade: 8.24 }

  test('the level, a short bar, the XP, the missions running and the last grade', () => {
    expect(statusText('auto', facts)).toBe('🛡 Lv 7 ▰▰▰▱▱ 340/500 xp · 2 missions · last prompt 8.2')
    expect(statusText('line', { ...facts, running: 1, grade: null })).toBe('🛡 Lv 7 ▰▰▰▱▱ 340/500 xp · 1 mission')
    expect(statusText('auto', { ...facts, running: 0, grade: 7 })).toBe('🛡 Lv 7 ▰▰▰▱▱ 340/500 xp · last prompt 7.0')
  })

  test('the egg once it can hatch, which the pane does', () => {
    const egg = { ...view, level: 1, pet: null }
    expect(statusText('auto', { ...facts, view: egg, running: 0, grade: null })).toBe(
      '🛡 Lv 1 ▰▰▰▱▱ 340/500 xp · 🥚 hatch it in /pathofdev',
    )
  })

  test('offline or signed out, what to do; before the first snapshot, that it connects; in full, nothing', () => {
    const signedOut = '⚔ Path of Dev · offline · sign in with /pathofdev login'
    expect(statusText('auto', { ...facts, link: 'offline' })).toBe(signedOut)
    expect(statusText('auto', { ...facts, link: 'connecting', view: null })).toBe('⚔ Path of Dev · connecting…')
    expect(statusText('full', facts)).toBeNull()
  })

  test('the grade\'s tone by the grade it shows: good from 8.0, weak under 5.0, plain between', () => {
    expect(gradeSegment(8)).toEqual({ role: 'good', text: '8.0' })
    expect(gradeSegment(7.96)).toEqual({ role: 'good', text: '8.0' })
    expect(gradeSegment(7.94)).toEqual({ role: 'grade', text: '7.9' })
    expect(gradeSegment(4.96)).toEqual({ role: 'grade', text: '5.0' })
    expect(gradeSegment(4.94)).toEqual({ role: 'weak', text: '4.9' })
  })

  test('counts the missions running, not those done, on offer or past their window', () => {
    const mission = (status: MissionView['status'], progress = 1, expiresAt: number | null = null): MissionView => ({
      questId: `q-${status}-${progress}`,
      title: 'Ship it',
      description: null,
      cadence: 'daily',
      status,
      progress,
      goal: 3,
      goalKind: null,
      rewards: { xp: 10, gold: 0, loot: null },
      expiresAt,
    })
    const missions: MissionsView = {
      isKnown: true,
      quests: [
        mission('active'),
        mission('active', 3),
        mission('offered'),
        mission('completed'),
        mission('active', 2, 9),
      ],
      weeklyActive: null,
      tiers: { daily: null, weekly: null },
    }
    expect(runningCount(missions, 5)).toBe(2)
    expect(runningCount(missions, 9)).toBe(1)
    expect(runningCount({ ...missions, isKnown: false }, 10)).toBe(0)
    expect(runningCount(null, 10)).toBe(0)
  })
})
