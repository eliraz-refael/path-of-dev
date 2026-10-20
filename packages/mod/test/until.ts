import type { MockClock } from 'claude-code/testing'

// How long one `until` waits for the mod, in real time: well past what its work takes on a busy CI runner (a few
// hundred ms at worst), and inside the five seconds a test may run, though a test's several waits share those.
const patienceMs = 3_000

/**
 * Lets the mod's work run until `check` holds, settling the clock between looks; the clock never moves.
 *
 * Bounded by real time, not by a count of settles: a settle sees the clock's waits and the event loop, not work the mod
 * awaits outside `$`. Its subject keys are HMACs over `crypto.subtle.digest`, which resolves off the event loop: while
 * one runs on a busy machine, a hundred settles can pass in a few ms, and the mod has not got to its next call.
 */
export const until = async (clock: MockClock, check: () => boolean | Promise<boolean>) => {
  const deadline = performance.now() + patienceMs
  for (;;) {
    if (await check()) return
    if (performance.now() > deadline) throw new Error(`the mod never got there: ${String(check)}`)
    await clock.settle()
  }
}
