import { RateLimited } from "@pathofdev/schema"
import { Clock, Context, Duration, Effect, HashMap, Layer, Option, Ref } from "effect"
import { HttpEffect, HttpServerResponse } from "effect/http"

// A token bucket for each key a rule limits: a client address, or a player. The decision is pure, so a property can
// check it; the buckets sit in one Ref, so two requests for the same key at once never both take the last token.
//
//   take(rule, bucket, now, cost)
//     └─▶ refilled: one token back for every `everyMs` since the bucket's `at`, up to `capacity`
//           ├─ tokens ≥ cost ─▶ allowed, `cost` taken
//           └─ else ──────────▶ refused, nothing taken; retryAfterMs: until the bucket holds `cost` again
//
// Whole tokens only: `at` moves on by whole tokens, so the part of a token earned so far is kept, never rounded up or
// lost. A key never seen starts full, so a bucket that has filled up again is the same as none: `prune` drops it, and
// the Ref holds only the keys limited lately. Over any window of W ms a key is let through at most
// `capacity + ⌈W / everyMs⌉` tokens' worth, whatever it asks for.

/** A limit: how much a key can take at once, and how fast it comes back. */
export interface Rule {
  /** Keeps this rule's buckets apart from another's. */
  readonly name: string
  /** The most a key can take at once, and what a key never seen starts with. */
  readonly capacity: number
  /** One token comes back every this many milliseconds. */
  readonly everyMs: number
}

/** A key's tokens, as last counted at `at`; the next comes back at `at + everyMs`. */
export interface Bucket {
  readonly tokens: number
  readonly at: number
}

/** What a take decided, and the bucket after it. */
export interface Taken {
  readonly allowed: boolean
  readonly bucket: Bucket
  /** 0 when allowed; otherwise how long until the bucket holds the cost asked for. */
  readonly retryAfterMs: number
}

/**
 * The bucket as of `now`: a token back for every whole `everyMs` since `at`, up to the capacity. A clock gone back
 * earns nothing.
 */
export const refilled = (rule: Rule, bucket: Bucket | undefined, now: number): Bucket => {
  if (bucket === undefined) return { tokens: rule.capacity, at: now }
  const earned = Math.floor(Math.max(0, now - bucket.at) / rule.everyMs)
  const tokens = bucket.tokens + earned
  if (tokens >= rule.capacity) return { tokens: rule.capacity, at: now }
  return { tokens, at: bucket.at + earned * rule.everyMs }
}

/**
 * Takes `cost` tokens from `bucket` (none for a key never seen) at `now`, or refuses and takes nothing. A cost over the
 * capacity never fits: it is told to wait for a full bucket, and refused again then.
 */
export const take = (rule: Rule, bucket: Bucket | undefined, now: number, cost = 1): Taken => {
  const current = refilled(rule, bucket, now)
  if (current.tokens >= cost) {
    return { allowed: true, bucket: { tokens: current.tokens - cost, at: current.at }, retryAfterMs: 0 }
  }
  const short = Math.min(cost, rule.capacity) - current.tokens
  return { allowed: false, bucket: current, retryAfterMs: Math.max(1, current.at + short * rule.everyMs - now) }
}

/** The buckets worth keeping at `now`: one that has filled up again is dropped, as a key never seen starts full. */
export const prune = (
  buckets: HashMap.HashMap<string, Bucket>,
  now: number,
  rule: Rule,
): HashMap.HashMap<string, Bucket> =>
  HashMap.filter(buckets, (bucket) => refilled(rule, bucket, now).tokens < rule.capacity)

/** How often the buckets that filled up again are dropped. */
export const pruneEvery = Duration.minutes(1)

/** The 429 for a refusal: when to try again, in whole milliseconds. */
export const rateLimited = (retryAfterMs: number): RateLimited =>
  new RateLimited({
    code: "rate_limited",
    message: `Too many requests: try again in ${Math.ceil(retryAfterMs / 1000)} s`,
    retryAfterMs: Math.ceil(retryAfterMs),
  })

/** A refusal's wait as `Retry-After` writes it: whole seconds, rounded up, so a client that waits that long gets in. */
export const retryAfterSecondsOf = (retryAfterMs: number): string => String(Math.max(1, Math.ceil(retryAfterMs / 1000)))

/** `effect`, whose 429 also carries `Retry-After`, for a client that reads only the header. */
export const withRetryAfter = <A, E, R>(effect: Effect.Effect<A, E | RateLimited, R>) =>
  Effect.tapError(effect, (error) =>
    error instanceof RateLimited
      ? HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(HttpServerResponse.setHeader(response, "retry-after", retryAfterSecondsOf(error.retryAfterMs)))
      )
      : Effect.void
  )

/** One rule's buckets, by key. */
interface Held {
  readonly rule: Rule
  readonly buckets: HashMap.HashMap<string, Bucket>
}

const make = Effect.gen(function* () {
  const held = yield* Ref.make<ReadonlyMap<string, Held>>(new Map())

  const check = (key: string, rule: Rule, cost = 1) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Ref.modify(held, (all): [Taken, ReadonlyMap<string, Held>] => {
        const buckets = all.get(rule.name)?.buckets ?? HashMap.empty<string, Bucket>()
        const taken = take(rule, Option.getOrUndefined(HashMap.get(buckets, key)), now, cost)
        return [taken, new Map(all).set(rule.name, { rule, buckets: HashMap.set(buckets, key, taken.bucket) })]
      })).pipe(
        Effect.flatMap((taken) => (taken.allowed ? Effect.void : Effect.fail(rateLimited(taken.retryAfterMs)))),
      )

  const pruned = Effect.flatMap(Clock.currentTimeMillis, (now) =>
    Ref.update(held, (all) =>
      new Map([...all].map(([name, { rule, buckets }]) => [name, { rule, buckets: prune(buckets, now, rule) }])))
  )
  yield* Effect.forkScoped(Effect.forever(Effect.andThen(Effect.sleep(pruneEvery), pruned)))

  return RateLimiter.of({ check })
})

export class RateLimiter extends Context.Service<
  RateLimiter,
  {
    /** Takes `cost` (1 unless said) from `key`'s bucket under `rule`, or fails, taking nothing, with when to retry. */
    readonly check: (key: string, rule: Rule, cost?: number) => Effect.Effect<void, RateLimited>
  }
>()("pathofdev/RateLimiter") {
  /** The buckets in memory, pruned every `pruneEvery` for as long as the layer lives. */
  static readonly layer = Layer.effect(RateLimiter, make)
  /** Lets everything through: the local server's, whose one player is the machine's own. */
  static readonly unlimited = Layer.succeed(RateLimiter, RateLimiter.of({ check: () => Effect.void }))
}
