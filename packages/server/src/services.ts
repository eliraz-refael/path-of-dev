import { step } from "@pathofdev/engine"
import { Layer } from "effect"
import type { Database } from "./db.ts"
import { sqlLayer } from "./db.ts"
import { DevMode } from "./game.ts"
import { StreamHub } from "./hub.ts"
import { migrate } from "./migrations.ts"
import type { ServerKind } from "./players.ts"
import { Players } from "./players.ts"
import { Presence } from "./presence.ts"
import { QuestPacks } from "./quest-packs.ts"
import { ServerRandom } from "./random.ts"
import { RateLimiter } from "./rate-limit.ts"
import type { Stepper } from "./writer.ts"
import { PlayerWriter } from "./writer.ts"

// What every server runs behind its routes, whatever it serves and whoever it plays for. Each server adds who a
// request acts for on top, as its `Authentication`: the local server its one player.
//
//   ServerRandom (seeded once) ─┐
//   DevMode (local only) ───────┤
//   RateLimiter (online only) ──┤
//   Database ─▶ migrate ────────┼─▶ QuestPacks ─▶ StreamHub ─▶ PlayerWriter ─▶ Players(kind), Presence (+ sweep)
//                               ┘

export interface CoreOptions {
  /** The engine's step, swappable so tests can make it fail. */
  readonly stepper?: Stepper | undefined
  /** Dev mode: the dev commands are taken. Only the local dev sandbox asks, and only a local server heeds it. */
  readonly dev?: boolean | undefined
  /** Seeds the server's randomness, so a test sees the same ids twice; from the OS when unset. */
  readonly seed?: string | undefined
}

/**
 * Whether a `kind` server built with `options` is in dev mode: only a local one that asks. An online server never is,
 * whatever its options hold, so no setting of the public server can let a dev command through.
 */
export const devModeOf = (kind: ServerKind, options: CoreOptions): boolean => kind === "local" && options.dev === true

/**
 * The rate limits of a `kind` server: an online one's buckets (limits.ts); a local one lets everything through, as its
 * one player is the machine's own.
 */
export const rateLimiterOf = (kind: ServerKind) => (kind === "online" ? RateLimiter.layer : RateLimiter.unlimited)

/** The server's randomness, seeded once, then the database, migrated. */
const Base = (database: Database, seed: string | undefined) =>
  Layer.effectDiscard(migrate).pipe(
    Layer.provideMerge(sqlLayer(database)),
    Layer.provideMerge(ServerRandom.layer(seed)),
  )

/**
 * The services behind the routes of a `kind` server, over `database`: migrated, with the presence sweep running, in
 * dev mode only as `devModeOf` allows, and rate-limited only online.
 */
export const core = (kind: ServerKind, database: Database, options: CoreOptions = {}) => {
  const Live = Presence.sweeper.pipe(Layer.provideMerge(Presence.layer))
  return Layer.mergeAll(Players.layer(kind), Live).pipe(
    Layer.provideMerge(PlayerWriter.make(options.stepper ?? step)),
    Layer.provideMerge(StreamHub.layer),
    Layer.provideMerge(QuestPacks.layer),
    Layer.provideMerge(Base(database, options.seed)),
    Layer.provideMerge(DevMode.layer(devModeOf(kind, options))),
    Layer.provideMerge(rateLimiterOf(kind)),
  )
}
