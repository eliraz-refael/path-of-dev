import { RateLimited } from "@pathofdev/schema"
import { Effect, Option, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { clientIpOf, limitKeyOf, publicTrust } from "./client-ip.ts"
import type { Rule } from "./rate-limit.ts"
import { RateLimiter, retryAfterSecondsOf, withRetryAfter } from "./rate-limit.ts"

// The public server's rate limits, all in one place. Only the public server limits: the local server's RateLimiter
// lets everything through (services.ts).
//
//   /v1/auth/*  per client address ─▶ auth     signing in and out: a person does it once per machine
//   /u/*        per client address ─▶ pages    each view renders a snapshot, uncached (profile.ts)
//   /v1/events  per player ─────────▶ writes, then events: one token per event in the batch
//   /v1/commands per player ────────▶ writes
//
// The mod's own pace, which the per-player numbers are set from. Every Claude Code session runs its own copy of the
// mod, and they share one queue on disk. A copy sends what waits (a batch of up to 100 events a request) when a
// main-loop turn ends and every 30 seconds, and only when something waits: a flush of an empty queue sends nothing.
// A busy session ends a turn every 15 seconds or so and makes about 20 events a minute: a turn's `turn.completed` and
// `context.measured`, a typed prompt's grade and command, and its subagents' commits and test runs. Ten such sessions
// side by side make about 60 requests and 200 events a minute; thirty, with turns every 5 seconds, about 420 requests
// (12 turn ends and 2 timer flushes a minute each) and 600 events. Copies flushing at once can send the same
// events twice, and both count. Commands are a person's clicks and typed commands: a few a minute.
//
// So `writes` lets 600 requests a minute through, and `events` 600 events a minute, with room for a burst of ten full
// batches: the queue a mod kept while it was offline (5000 events at most) goes in about 7 minutes. Past either, the
// request is answered 429 with `retryAfterMs`, and the mod keeps the events and tries again then (hooks/register.tsx,
// `flush`). For the volume badges (100 commits, 50 merges, 500 graded prompts) the cap bounds how fast a made-up count
// can grow, not whether it can: TODOS.md keeps counting them from verified work.

/** Every limit, by what it guards. */
export const limits = {
  /** `/v1/auth/*`, per client address: 30 at once (an office signing in behind one address), then 20 a minute. */
  auth: { name: "auth", capacity: 30, everyMs: 3_000 },
  /** `/u/*`, per client address: 60 at once, then 60 a minute. */
  pages: { name: "pages", capacity: 60, everyMs: 1_000 },
  /** `POST /v1/events` and `/v1/commands`, per player: 300 at once, then 600 a minute. */
  writes: { name: "writes", capacity: 300, everyMs: 100 },
  /** The events in those requests, per player: 1000 at once (ten full batches), then 600 a minute. */
  events: { name: "events", capacity: 1_000, everyMs: 100 },
} satisfies Record<string, Rule>

/** The rule a path is limited by per client address, or null for one limited per player, or not at all. */
export const addressRuleOf = (path: string): Rule | null =>
  path.startsWith("/v1/auth/") ? limits.auth : path === "/u" || path.startsWith("/u/") ? limits.pages : null

/** A request's path, without its query. */
const pathOf = (url: string): string => url.split("?")[0] ?? url

const encodeLimited = Schema.encodeSync(RateLimited)

/** The 429 a route the HTTP API doesn't answer for gets: the same body as the API's, and `Retry-After`. */
export const limitedResponse = (error: RateLimited): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(encodeLimited(error), {
    status: 429,
    headers: { "retry-after": retryAfterSecondsOf(error.retryAfterMs) },
  })

/**
 * The limits per client address, before any route runs: a refused request is answered 429 and goes no further, so
 * GitHub is never asked and no page is rendered.
 */
export const AddressLimits = HttpRouter.middleware(
  Effect.gen(function* () {
    const limiter = yield* RateLimiter
    return (app) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const rule = addressRuleOf(pathOf(request.url))
        if (rule === null) return yield* app
        const ip = clientIpOf(publicTrust, request.headers, Option.getOrNull(request.remoteAddress))
        return yield* Effect.matchEffect(limiter.check(limitKeyOf(ip), rule), {
          onFailure: (refused) => Effect.succeed(limitedResponse(refused)),
          onSuccess: () => app,
        })
      })
  }),
  { global: true },
)

/** A player's write: `events` of them in a batch (none for a command), checked against both per-player limits. */
export const limitWrite = (limiter: RateLimiter["Service"], playerId: string, events: number) =>
  withRetryAfter(
    Effect.andThen(
      limiter.check(playerId, limits.writes),
      events === 0 ? Effect.void : limiter.check(playerId, limits.events, events),
    ),
  )
