import type { ServerEvent } from '@pathofdev/schema'
import type {
  Celebration,
  Facing,
  Motion,
  PetDisplay,
  PetLook,
  PetMark,
  PetPose,
  PetScene,
  Stage,
  Tier,
} from '../types'
import { celebrationOf, tierOf, tierRank } from './celebrate'
import type { Row, Run } from './cells'
import { blank, cellsOf, cellsOfRow } from './cells'
import { hash, rarityColors } from './frames'
import { argsOf, isRecord } from './server'

// The living pet: how it wanders band row 2, how it reacts to play, and how it is drawn in its lane. Everything here
// takes and gives plain values; register.tsx runs the timers, keeps the walker and draws what these work out.
//
//   stream batch ─▶ reactionsOf ─▶ withReactions ─▶ walker.queue
//   timer ───────▶ stepWalker(walker, context) ─▶ { walker, waitMs } ─▶ the next timer, or none while waitMs is null
//                    └─▶ poseOf ─▶ PetScene (state, written only when it changed) ─▶ petRowOf ─▶ band row 2
//
// The pet only ever reacts to good things: a well-graded prompt, a drop, a meal, a pat, a celebration. A weak or
// ungraded prompt changes nothing, and a low mood only makes it rest longer: it is never drawn sad.

/** A prompt graded this or more, to one decimal as the band shows the grade, makes the pet hop. */
export const wellGradedAt = 7
/** No prompt, pat or meal for this long, and the pet falls asleep. */
export const napMs = 10 * 60_000
/** A step of the walk, and a frame of a reaction: about 2 fps. A trot, fetching a drop, is twice as quick. */
export const walkMs = 500
const trotMs = 250
/** The cells the pet wanders, when the row leaves it that many. */
export const wanderLane = 16
/** Reactions that wait their turn, past which the oldest give way. */
const maxWaiting = 3

// The player's choice, kept in the mod's store.

/** Where the store keeps the choice: one for every server, as it is how the band looks, not game state. */
export const petDisplayKey = 'petDisplay'

/** On the band and wandering: the pet before the player chose anything. */
export const wanderingPet: PetDisplay = { hidden: false, still: false }

/** The choice as the store kept it; anything else reads as the pet on the band, wandering. */
export const displayOf = (stored: unknown): PetDisplay =>
  isRecord(stored) ? { hidden: stored['hidden'] === true, still: stored['still'] === true } : wanderingPet

/**
 * What `/pathofdev pet …` asks: where the pet stands, to make it still, wander, hide or come back, or its tip about
 * the last graded prompt.
 */
export type PetAsk = { readonly kind: 'view' | 'still' | 'move' | 'hide' | 'show' | 'tip' }

export const petUsage = 'The pet on the band: /pathofdev pet | still | move | hide | show | tip.'

/** What `/pathofdev <args>` asks of the pet: null when the args are not `pet …`, the usage when they don't parse. */
export const petAskOf = (args: string): PetAsk | string | null => {
  const [head, what, ...rest] = argsOf(args)
  if (head !== 'pet') return null
  if (rest.length > 0) return petUsage
  if (what === undefined) return { kind: 'view' }
  return what === 'still' || what === 'move' || what === 'hide' || what === 'show' || what === 'tip'
    ? { kind: what }
    : petUsage
}

/** The choice after an ask: still and move put the pet on the band too; show brings it back as it was. */
export const displayAfter = (ask: PetAsk, display: PetDisplay): PetDisplay => {
  switch (ask.kind) {
    case 'view':
    case 'tip':
      return display
    case 'still':
      return { hidden: false, still: true }
    case 'move':
      return { hidden: false, still: false }
    case 'hide':
      return { ...display, hidden: true }
    case 'show':
      return { ...display, hidden: false }
  }
}

/** Where the pet stands, in words, and what turns it around; `name` null before the hatch. */
export const petDisplayText = (display: PetDisplay, name: string | null, motion: Motion): string => {
  const who = name ?? 'Your pet'
  if (display.hidden) return `${who} is off the band; its mood and XP bonus stay. /pathofdev pet show brings it back.`
  if (display.still)
    return `${who} sits still on the band, and still reacts to your work. /pathofdev pet move lets it wander.`
  if (motion !== 'full') {
    const still = `${who} sits still on the band while Celebrations is ${motion}, and wanders once it is full.`
    return `${still} /pathofdev pet hide takes it off the band.`
  }
  return `${who} wanders the band. /pathofdev pet still keeps it in place; /pathofdev pet hide takes it off the band.`
}

/** The choice in a few words, for the pet's card. */
export const petDisplayWord = (display: PetDisplay, motion: Motion): string =>
  display.hidden
    ? 'Hidden from the band'
    : display.still
      ? 'Sitting still on the band'
      : motion === 'full'
        ? 'Wandering the band'
        : `Still on the band while Celebrations is ${motion}`

// How the pet moves.

/** How the pet may move: wander the lane, and play its reactions frame by frame rather than as one still frame. */
export type PetMode = { wanders: boolean; animates: boolean }

/** It wanders only in full motion, and when the player hasn't stilled it; reduced and off show still frames. */
export const modeOf = (motion: Motion, display: PetDisplay): PetMode => ({
  wanders: motion === 'full' && !display.still && !display.hidden,
  animates: motion === 'full',
})

/**
 * What a step goes by: the mode; whether the band is free for the pet (no main-loop turn, no celebration playing or
 * waiting); whether its mood is low, which makes it rest longer; how far from its place its lane lets it go; and
 * whether it `holds` still where it stands, as it does while it speaks, its reactions still played first.
 */
export type StepContext = PetMode & { free: boolean; sleepy: boolean; room: number; holds?: boolean }

/** Something the pet does about a moment of play. */
export type Reaction =
  | { readonly kind: 'hop' | 'eat' | 'pat' | 'cheer' }
  | { readonly kind: 'fetch'; readonly item: PetMark }

/**
 * A reaction playing, at a frame: `from` is where it began, which a fetch comes back to; a fetch trots `out` to the
 * lane's far end, is `off` it a moment, comes `back` carrying the drop and `show`s it.
 */
type Act = {
  readonly reaction: Reaction
  readonly frame: number
  readonly from: number
  readonly phase: 'out' | 'off' | 'back' | 'show'
}

/**
 * The pet's whereabouts and plans, kept in the mod's memory: `away` cells from its place beside its name, the way it
 * faces, where it walks to, the steps taken (which seed its choices), the reaction playing and those waiting, and
 * whether it sleeps.
 */
export type Walker = {
  readonly away: number
  readonly facing: Facing
  readonly walkTo: number | null
  readonly turn: number
  readonly act: Act | null
  readonly queue: ReadonlyArray<Reaction>
  readonly asleep: boolean
}

/** The pet in its place beside its name, facing it, awake, with nothing to do. */
export const homeWalker: Walker = {
  away: 0,
  facing: 'right',
  walkTo: null,
  turn: 0,
  act: null,
  queue: [],
  asleep: false,
}

/** A step: the walker after it, and how long until the next; null when nothing will change until something happens. */
export type Step = { walker: Walker; waitMs: number | null }

/** The walker a fresh copy of the mod starts from: where the pose it last drew stood, in its place if it can't move. */
export const walkerOf = (scene: PetScene | null, mode: PetMode): Walker => {
  if (scene === null) return homeWalker
  const { pose } = scene
  const asleep = pose.look === 'asleep'
  if (!mode.wanders || pose.isAway || asleep) return { ...homeWalker, asleep }
  return { ...homeWalker, away: pose.away, facing: pose.facing }
}

/** Asleep: what it was doing and meant to do are let go. */
export const asleepWalker = (walker: Walker): Walker => ({
  ...walker,
  asleep: true,
  act: null,
  queue: [],
  walkTo: null,
  facing: 'right',
})

/** Back in its place, as when it is stilled or hidden: its walk is let go, its reactions kept to play there. */
export const settledWalker = (walker: Walker): Walker => ({
  ...homeWalker,
  turn: walker.turn,
  asleep: walker.asleep,
  queue: heldWalker(walker).queue,
})

/** Reactions join the queue, each kind once (the newest of a kind wins), and wake the pet. */
export const withReactions = (walker: Walker, reactions: ReadonlyArray<Reaction>): Walker => {
  if (reactions.length === 0) return walker
  const queue = reactions
    .reduce<ReadonlyArray<Reaction>>(
      (waiting, reaction) =>
        waiting.some((one) => one.kind === reaction.kind)
          ? waiting.map((one) => (one.kind === reaction.kind ? reaction : one))
          : [...waiting, reaction],
      walker.queue,
    )
    .slice(-maxWaiting)
  return { ...walker, asleep: false, queue }
}

/**
 * A turn or a celebration came while a reaction played: it stops, the pet back where it began, and plays again whole
 * once the band is free, as a celebration does.
 */
export const heldWalker = (walker: Walker): Walker => {
  const { act } = walker
  if (act === null) return { ...walker, walkTo: null }
  const facing = act.reaction.kind === 'fetch' ? 'right' : walker.facing
  return { ...walker, away: act.from, facing, act: null, walkTo: null, queue: [act.reaction, ...walker.queue] }
}

/** The room the pet may wander in: what the band last drew, or before it draws after a reload, where the pet stands. */
export const roomNow = (drawn: number | null, walker: Walker): number => drawn ?? walker.away

/** Whether the pet has a step to take now: a reaction to play, or a wander, once the band is free. */
export const wantsStep = (walker: Walker, context: Pick<StepContext, 'free' | 'wanders' | 'holds'>): boolean =>
  !walker.asleep &&
  context.free &&
  (walker.act !== null || walker.queue.length > 0 || (context.wanders && context.holds !== true))

/** How long one still frame of a reaction stands, when the player wants reduced motion or none. */
const stillMs: Record<Reaction['kind'], number> = { hop: 2_000, eat: 2_000, pat: 1_500, cheer: 3_000, fetch: 2_500 }

/** One step of the pet's life: a frame of the reaction playing, the next reaction, or a bit of wandering. */
export const stepWalker = (walker: Walker, context: StepContext): Step => {
  if (walker.asleep) return { walker, waitMs: null }
  const placed = placedIn(walker, context.room)
  if (!context.free) return { walker: heldWalker(placed), waitMs: null }
  return placed.act === null ? nextStep(placed, context) : advance(placed, placed.act, context)
}

/**
 * The walker inside a room that may have shrunk since its last step: where it stands, where it walks to and where its
 * reaction began, each pulled back into the room, so no step taken from them can leave it.
 */
const placedIn = (walker: Walker, room: number): Walker => {
  const inside = (cell: number) => Math.max(0, Math.min(cell, room))
  const { act, walkTo } = walker
  return {
    ...walker,
    away: inside(walker.away),
    walkTo: walkTo === null ? null : inside(walkTo),
    act: act === null ? null : { ...act, from: inside(act.from) },
  }
}

/**
 * With nothing playing: the next reaction, else a step of the wander; a pet that doesn't wander sits in its place, and
 * one that holds stays where it stands.
 */
const nextStep = (walker: Walker, context: StepContext): Step => {
  const [reaction, ...rest] = walker.queue
  if (reaction !== undefined) return begin({ ...walker, queue: rest, walkTo: null }, reaction, context)
  if (context.holds === true) return { walker: { ...walker, walkTo: null }, waitMs: null }
  if (!context.wanders) return { walker: { ...walker, away: 0, facing: 'right', walkTo: null }, waitMs: null }
  return wander(walker, context)
}

const begin = (walker: Walker, reaction: Reaction, context: StepContext): Step => {
  const from = walker.away
  if (reaction.kind === 'fetch' && context.wanders && context.animates && context.room > 0) {
    const act: Act = { reaction, frame: 0, from, phase: 'out' }
    return { walker: { ...walker, act, away: Math.min(context.room, from + 2), facing: 'left' }, waitMs: trotMs }
  }
  const act: Act = { reaction, frame: 0, from, phase: 'show' }
  return { walker: { ...walker, act }, waitMs: context.animates ? walkMs : stillMs[reaction.kind] }
}

/** Frames a reaction shows in place, frame by frame; one still frame without motion. */
const framesOf = (reaction: Reaction, context: PetMode): number =>
  !context.animates ? 1 : reaction.kind === 'fetch' ? fetchShow : scripts[reaction.kind]('right').length

const fetchShow = 3

const advance = (walker: Walker, act: Act, context: StepContext): Step => {
  const at = (next: Partial<Act>, change: Partial<Walker>, waitMs: number): Step => ({
    walker: { ...walker, ...change, act: { ...act, ...next } },
    waitMs,
  })
  switch (act.phase) {
    case 'out':
      return walker.away >= context.room
        ? at({ phase: 'off', frame: 0 }, {}, trotMs)
        : at({}, { away: Math.min(context.room, walker.away + 2) }, trotMs)
    case 'off':
      return act.frame < 1
        ? at({ frame: act.frame + 1 }, {}, trotMs)
        : at({ phase: 'back', frame: 0 }, { away: context.room, facing: 'right' }, trotMs)
    case 'back': {
      const away = Math.max(act.from, walker.away - 2)
      return away === act.from ? at({ phase: 'show', frame: 0 }, { away }, walkMs) : at({}, { away }, trotMs)
    }
    case 'show':
      if (act.frame + 1 < framesOf(act.reaction, context)) return at({ frame: act.frame + 1 }, {}, walkMs)
      return nextStep({ ...walker, act: null, away: act.from }, context)
  }
}

/** Walks a cell toward where it is going; arrived, it picks what next: a walk, a look around, or a sit. */
const wander = (walker: Walker, context: StepContext): Step => {
  const turn = walker.turn + 1
  const { away, walkTo } = walker
  if (walkTo !== null && walkTo !== away) {
    const step = away + Math.sign(walkTo - away)
    const facing: Facing = walkTo > away ? 'left' : 'right'
    return { walker: { ...walker, turn, away: step, facing, walkTo: step === walkTo ? null : walkTo }, waitMs: walkMs }
  }
  const roll = hash(turn, 1)
  // A sleepy pet rests twice as long: low mood reads as sleepy, never sad.
  const rest = Math.round((1_500 + hash(turn, 2) * 4_500) * (context.sleepy ? 2 : 1))
  if (roll < 0.5 && context.room >= 2) {
    const picked = Math.floor(hash(turn, 3) * (context.room + 1))
    const to = Math.abs(picked - away) >= 2 ? picked : away + 2 <= context.room ? away + 2 : Math.max(0, away - 2)
    const step = away + Math.sign(to - away)
    const facing: Facing = to > away ? 'left' : 'right'
    return { walker: { ...walker, turn, away: step, facing, walkTo: step === to ? null : to }, waitMs: walkMs }
  }
  // Looks around, or sits a while; a sit changes nothing on the band, so nothing is drawn until the next step.
  const facing: Facing = roll < 0.7 ? (walker.facing === 'left' ? 'right' : 'left') : walker.facing
  return { walker: { ...walker, turn, facing, walkTo: null }, waitMs: rest }
}

// What the pet looks like.

const gold = '#ffd23f'
const pink = '#ff8fb1'
const crumbColor = '#e0a526'
const spark: PetMark = { text: '✧', color: gold }

/** A frame of a reaction: the face, and the marks on the pet's left and right. */
type Frame = { look: PetLook; left: PetMark | null; right: PetMark | null }

/** Marks on the left and right as marks behind and before a pet facing `facing`. */
const sided = (frame: Frame, facing: Facing): Pick<PetPose, 'look' | 'back' | 'front'> =>
  facing === 'right'
    ? { look: frame.look, back: frame.left, front: frame.right }
    : { look: frame.look, back: frame.right, front: frame.left }

/** Before the face as it faces: a frame whose one mark is on its front. */
const ahead = (look: PetLook, mark: PetMark | null, facing: Facing): Frame =>
  facing === 'right' ? { look, left: null, right: mark } : { look, left: mark, right: null }

const scripts: Record<'hop' | 'eat' | 'pat' | 'cheer', (facing: Facing) => ReadonlyArray<Frame>> = {
  // A happy little bounce in sparkles.
  hop: (facing) => [
    { look: 'happy', left: spark, right: spark },
    ahead('happy', { text: '♪', color: gold }, facing),
    { look: 'happy', left: spark, right: spark },
    ahead('happy', null, facing),
  ],
  // A treat eaten down to crumbs.
  eat: (facing) => [
    ahead('chew', { text: '●', color: crumbColor }, facing),
    ahead('idle', { text: '◐', color: crumbColor }, facing),
    ahead('chew', { text: '·', color: crumbColor }, facing),
    ahead('happy', null, facing),
  ],
  pat: (facing) => [
    ahead('happy', { text: '♥', color: pink }, facing),
    ahead('happy', { text: '♡', color: pink }, facing),
    ahead('happy', { text: '♥', color: pink }, facing),
  ],
  // Arms up, then sparkles, by turns.
  cheer: () => [
    { look: 'happy', left: { text: '\\', color: gold }, right: { text: '/', color: gold } },
    { look: 'happy', left: spark, right: spark },
  ],
}

/** The pet as it stands now, from the walker. */
export const poseOf = (walker: Walker, mode: PetMode): PetPose => {
  const { away, facing } = walker
  const base: PetPose = { away, facing, look: 'idle', back: null, front: null, isAway: false }
  if (walker.asleep) return { ...base, facing: 'right', look: 'asleep', front: { text: ' z z', dim: true } }
  const { act } = walker
  if (act === null) return base
  const { reaction } = act
  if (reaction.kind === 'fetch') {
    if (act.phase === 'out') return base
    if (act.phase === 'off') return { ...base, isAway: true }
    if (act.phase === 'back') return { ...base, front: reaction.item }
    const glint = mode.animates && act.frame % 2 === 0 ? spark : null
    return { ...base, look: 'happy', back: glint, front: reaction.item }
  }
  const frames = scripts[reaction.kind](walker.facing)
  const frame = frames[mode.animates ? Math.min(act.frame, frames.length - 1) : 0] ?? ahead('idle', null, walker.facing)
  return { ...base, ...sided(frame, walker.facing) }
}

/** Whether the pet cheers while a celebration plays: for a level-up, and for a rare drop or mission and up. */
export const cheersFor = (celebration: Celebration): boolean =>
  celebration.kind === 'level' || (celebration.kind !== 'xp' && tierRank(celebration.tier) >= tierRank('rare'))

/**
 * The pose while a celebration plays: a cheer in time with its frames (arms up and sparkles by turns, about 2 fps), a
 * single still one in reduced motion, where it has one frame. A sleeping pet, or one off fetching, sleeps through it.
 */
export const stagedPose = (pose: PetPose, stage: Stage | null): PetPose => {
  if (stage === null || !cheersFor(stage.celebration) || pose.look === 'asleep' || pose.isAway) return pose
  const frames = scripts.cheer(pose.facing)
  const frame = frames[Math.floor(stage.tick / 3) % frames.length] ?? frames[0]
  return frame === undefined ? pose : { ...pose, ...sided(frame, pose.facing) }
}

/** The pet as a scene to keep and draw. */
export const sceneOf = (walker: Walker, display: PetDisplay, activeAt: number, mode: PetMode): PetScene => ({
  pose: poseOf(walker, mode),
  display,
  activeAt,
})

/** Whether two scenes draw the same: a step that changes nothing on the band writes nothing, and redraws nothing. */
export const sameScene = (a: PetScene | null, b: PetScene | null): boolean => JSON.stringify(a) === JSON.stringify(b)

// What the pet reacts to.

/** A grade as the band shows it, to one decimal: a prompt the band says was graded 7 makes the pet hop. */
export const shownGrade = (grade: number): number => Math.round(grade * 10) / 10

/**
 * What the pet does about a batch of the stream (what one cause earned): it fetches a drop a prompt earned, carrying
 * the best of them, else hops for a well-graded prompt; it eats a meal and enjoys a pat. With celebrations off, it
 * cheers a level-up or a rare drop in place of the celebration. A prompt graded below the line, or not graded at all,
 * earns nothing from it.
 */
export const reactionsOf = (events: ReadonlyArray<ServerEvent>, motion: Motion): Array<Reaction> => {
  let graded = false
  let isWell = false
  let best: Tier | null = null
  let cheers = false
  for (const event of events) {
    if (event.type === 'xp.granted' && event.data.reason === 'prompt.graded') {
      graded = true
      if (event.data.grade !== undefined && shownGrade(event.data.grade) >= wellGradedAt) isWell = true
    }
    if (event.type === 'loot.dropped') {
      const tier = tierOf(event.data.tier)
      if (best === null || tierRank(tier) > tierRank(best)) best = tier
    }
    const celebration = celebrationOf(event, '')
    if (celebration !== null && cheersFor(celebration)) cheers = true
  }
  const reactions: Array<Reaction> = []
  if (graded && best !== null) reactions.push({ kind: 'fetch', item: { text: '◆', color: rarityColors[best] } })
  else if (isWell) reactions.push({ kind: 'hop' })
  if (events.some((event) => event.type === 'pet.fed')) reactions.push({ kind: 'eat' })
  if (events.some((event) => event.type === 'pet.petted')) reactions.push({ kind: 'pat' })
  if (motion === 'off' && cheers) reactions.push({ kind: 'cheer' })
  return reactions
}

// Where the pet is drawn: a lane on band row 2, its place at the lane's right end beside its name.

const faces: Record<string, Record<PetLook, string>> = {
  fox: { idle: 'ᓚᘏᗢ', happy: 'ᓚᘏᗢ', chew: 'ᓚᘏᗢ', asleep: 'ᓚᘏᗢ' },
  slime: { idle: '(•ᴗ•)', happy: '(^ᴗ^)', chew: '(•o•)', asleep: '(-ᴗ-)' },
  robot: { idle: '[o_o]', happy: '[^_^]', chew: '[o~o]', asleep: '[-_-]' },
  owl: { idle: '{◉,◉}', happy: '{^,^}', chew: '{◉o◉}', asleep: '{-,-}' },
}
/** The faces that look one way, as they look the other. */
const turned: Record<string, string> = { 'ᓚᘏᗢ': 'ᗢᘏᓗ' }

/** The face as the band draws it: the species' face for the look, turned the way it faces, a little grander by form. */
export const faceOf = (pet: { species: string; form: number }, look: PetLook, facing: Facing): string => {
  const species = faces[pet.species] ?? faces['fox']
  const straight = species?.[look] ?? 'ᓚᘏᗢ'
  const core = facing === 'left' ? (turned[straight] ?? straight) : straight
  switch (Math.max(0, Math.min(3, pet.form))) {
    case 1:
      return facing === 'left' ? `✧${core}` : `${core}✧`
    case 2:
      return `✧${core}✧`
    case 3:
      return `✦${core}✦`
    default:
      return core
  }
}

const markCells = (mark: PetMark | null): number => (mark === null ? 0 : cellsOf(mark.text))

const markRun = (mark: PetMark | null): Array<Run> => {
  if (mark === null) return []
  const color = mark.color === undefined ? {} : { color: mark.color }
  return [{ text: mark.text, ...color, ...(mark.dim === true ? { dim: true } : {}) }]
}

/** Runs with the empty ones left out: a blank of no cells draws nothing. */
const kept = (runs: ReadonlyArray<Run>): Row => runs.filter((run) => run.text !== '')

/** The marks on the pet's left and right, as it faces. */
const marksOf = (pose: PetPose): { left: PetMark | null; right: PetMark | null } =>
  pose.facing === 'right' ? { left: pose.back, right: pose.front } : { left: pose.front, right: pose.back }

/**
 * How wide the pet's lane is: when it wanders, up to `wanderLane` cells of the `room` the row leaves it; otherwise, or
 * with no room to spare, its face and a cell for a mark each side. A text set `beside` it widens the lane to hold it:
 * the seam for the pet's speech bubble.
 */
export const laneWidthOf = (
  face: string,
  pose: PetPose,
  wanders: boolean,
  room: number,
  beside: Row | null,
): number => {
  const { left, right } = marksOf(pose)
  const besideCells = beside === null ? 0 : cellsOfRow(beside) + 1
  const least = cellsOf(face) + Math.max(1, markCells(left)) + Math.max(1, markCells(right)) + besideCells
  return Math.max(least, Math.min(wanders ? Math.max(wanderLane, least) : least, room))
}

/** How far from its place a lane `lane` cells wide lets the pet go: its face and a mark's cell each side stay in it. */
export const roomOf = (lane: number, face: string): number => Math.max(0, lane - cellsOf(face) - 2)

/**
 * The lane, exactly `width` cells: the pet `away` cells left of its place at the right end, its marks either side, and
 * a text set `beside` it (the seam for the pet's speech bubble) on the side with room, after it when both have.
 */
export const laneRow = (face: string, pose: PetPose, width: number, beside: Row | null = null): Row => {
  if (pose.isAway) return kept([blank(width)])
  const { left, right } = marksOf(pose)
  const faceCells = cellsOf(face)
  const leftCells = markCells(left)
  const rightCells = markCells(right)
  const home = width - faceCells - Math.max(1, rightCells)
  const leftmost = Math.max(1, leftCells)
  const placed = Math.max(leftmost, Math.min(home, home - pose.away))
  const besideCells = beside === null ? 0 : cellsOfRow(beside) + 1
  const roomAfter = width - placed - faceCells - rightCells
  const roomBefore = placed - leftCells
  // A text that fits on neither side moves the pet toward the edge with more room, so that the text fits there.
  const x =
    besideCells <= roomAfter || besideCells <= roomBefore
      ? placed
      : roomAfter >= roomBefore
        ? Math.max(leftmost, width - faceCells - rightCells - besideCells)
        : Math.max(leftmost, leftCells + besideCells)
  const pet: Array<Run> = [...markRun(left), { text: face }, ...markRun(right)]
  const before = x - leftCells
  const after = width - x - faceCells - rightCells
  if (beside !== null && besideCells <= after)
    return kept([blank(before), ...pet, blank(1), ...beside, blank(after - besideCells)])
  if (beside !== null && besideCells <= before)
    return kept([blank(before - besideCells), ...beside, blank(1), ...pet, blank(after)])
  return kept([blank(before), ...pet, blank(after)])
}

/** The blank the pet stands after, apart from the rest: only the pet and its name take a click. */
export const leadOf = (row: Row): { lead: Row; rest: Row } => {
  const at = row.findIndex((run) => run.text.trim() !== '')
  const cut = at < 0 ? row.length : at
  return { lead: row.slice(0, cut), rest: row.slice(cut) }
}

/**
 * Band row 2's pet: its lane, then its name and hearts; null when the player hid it. `room` is what the row's other
 * pieces leave it, the mission's chip taking what it leaves in turn; `beside` is a text to set beside the pet: its
 * speech bubble (coach.ts), cut to the room. The room it may wander in goes back to the walker.
 */
export const petRowOf = (
  pet: { species: string; form: number; name: string },
  scene: PetScene,
  hearts: string,
  motion: Motion,
  stage: Stage | null,
  room: number,
  beside: Row | null = null,
): { row: Row; room: number } | null => {
  if (scene.display.hidden) return null
  const pose = stagedPose(scene.pose, stage)
  const face = faceOf(pet, pose.look, pose.facing)
  const label: Row = [{ text: ` ${pet.name} ` }, { text: hearts, color: 'error' }]
  const lane = laneWidthOf(face, pose, modeOf(motion, scene.display).wanders, room - cellsOfRow(label), beside)
  return { row: [...laneRow(face, pose, lane, beside), ...label], room: roomOf(lane, face) }
}
