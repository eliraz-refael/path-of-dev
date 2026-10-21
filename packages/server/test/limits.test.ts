import { it } from "@effect/vitest"
import { ApiError } from "@pathofdev/schema"
import { Effect, HashMap, Layer, Option, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import type { Bucket, Rule } from "../src/index.ts"
import {
  addressOf,
  clientIpOf,
  GitHub,
  isIn,
  limitKeyOf,
  limits,
  prune,
  publicTrust,
  take,
  textOf,
} from "../src/index.ts"
import { addressedWebHandler, client, dump, hatch, prompt, session, testPublicServices, withServer } from "./fixtures.ts"

// The public server's rate limits: the token bucket as properties, the client address as properties, and the limits
// on the routes as the public build serves them, the local server's let through.
//
//   take ─▶ at most capacity + ⌈W / everyMs⌉ over any W ms │ a refusal's wait is exact │ prune changes no outcome
//   clientIpOf ─▶ a header from a peer we don't trust never moves the key │ only the last X-Forwarded-For entry counts
//   /u/*, /v1/auth/* per address ─▶ 429 + Retry-After, nothing run │ /v1/events, /v1/commands per player ─▶ 429,
//   nothing written │ the local server ─▶ never limited

// ── the bucket ───────────────────────────────────────────────────────────────────────────────────────────────────────

const Drawn = Schema.Struct({
  capacity: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 40 })),
  everyMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
})
const ruleOf = (drawn: typeof Drawn.Type): Rule => ({ name: "test", ...drawn })

const Steps = Schema.Array(
  Schema.Struct({
    wait: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 800 })),
    cost: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 45 })),
  }),
).check(Schema.isMaxLength(60))

interface Step {
  readonly now: number
  readonly cost: number
  readonly allowed: boolean
  readonly before: Bucket | undefined
  readonly retryAfterMs: number
}

/** One key's takes, `steps` apart, from a key never seen. */
const run = (rule: Rule, steps: typeof Steps.Type, from = 1_000_000): Array<Step> => {
  let now = from
  let bucket: Bucket | undefined
  return steps.map(({ wait, cost }) => {
    now += wait
    const before = bucket
    const taken = take(rule, bucket, now, cost)
    bucket = taken.bucket
    return { now, cost, allowed: taken.allowed, before, retryAfterMs: taken.retryAfterMs }
  })
}

describe("take", () => {
  it.prop(
    "lets through at most capacity + ⌈W / everyMs⌉ over any window of W ms",
    [Drawn, Steps],
    ([drawn, steps]) => {
      const rule = ruleOf(drawn)
      const ran = run(rule, steps)
      for (let first = 0; first < ran.length; first++) {
        for (let last = first; last < ran.length; last++) {
          const window = ran.slice(first, last + 1)
          const taken = window.reduce((sum, step) => sum + (step.allowed ? step.cost : 0), 0)
          const span = (window[window.length - 1]?.now ?? 0) - (window[0]?.now ?? 0)
          expect(taken).toBeLessThanOrEqual(rule.capacity + Math.ceil(span / rule.everyMs))
        }
      }
    },
  )

  it.prop(
    "lets a refusal through exactly when its wait is over, and not a millisecond before, if nothing else takes",
    [Drawn, Steps],
    ([drawn, steps]) => {
      const rule = ruleOf(drawn)
      for (const step of run(rule, steps)) {
        if (step.allowed || step.cost > rule.capacity) continue
        const after = take(rule, step.before, step.now, step.cost).bucket
        expect(take(rule, after, step.now + step.retryAfterMs, step.cost).allowed).toBe(true)
        expect(take(rule, after, step.now + step.retryAfterMs - 1, step.cost).allowed).toBe(false)
      }
    },
  )

  it.prop(
    "takes nothing when it refuses, and never earns tokens from a clock gone back",
    [Drawn, Steps],
    ([drawn, steps]) => {
      const rule = ruleOf(drawn)
      for (const step of run(rule, steps)) {
        const taken = take(rule, step.before, step.now, step.cost)
        if (!taken.allowed) expect(taken.bucket.tokens).toBe(take(rule, step.before, step.now, 0).bucket.tokens)
        const back = take(rule, taken.bucket, step.now - 1_000, 0).bucket
        expect(back.tokens).toBe(taken.bucket.tokens)
      }
    },
  )

  it.prop("always lets a key never seen take up to its capacity", [Drawn], ([drawn]) => {
    const rule = ruleOf(drawn)
    expect(take(rule, undefined, 0, rule.capacity)).toEqual({
      allowed: true,
      bucket: { tokens: 0, at: 0 },
      retryAfterMs: 0,
    })
  })

  it.prop(
    "prune changes no later outcome: a bucket it drops is as good as a key never seen",
    [Drawn, Schema.Array(Steps).check(Schema.isMinLength(1), Schema.isMaxLength(5)), Steps],
    ([drawn, keys, later]) => {
      const rule = ruleOf(drawn)
      let buckets = HashMap.empty<string, Bucket>()
      let end = 1_000_000
      keys.forEach((steps, key) => {
        let now = 1_000_000
        let bucket: Bucket | undefined
        for (const { wait, cost } of steps) {
          now += wait
          bucket = take(rule, bucket, now, cost).bucket
        }
        end = Math.max(end, now)
        if (bucket !== undefined) buckets = HashMap.set(buckets, String(key), bucket)
      })
      const pruned = prune(buckets, end, rule)
      for (const [key] of buckets) {
        let now = end
        let kept = Option.getOrUndefined(HashMap.get(buckets, key))
        let dropped = Option.getOrUndefined(HashMap.get(pruned, key))
        for (const { wait, cost } of later) {
          now += wait
          const one = take(rule, kept, now, cost)
          const other = take(rule, dropped, now, cost)
          expect([other.allowed, other.retryAfterMs]).toEqual([one.allowed, one.retryAfterMs])
          kept = one.bucket
          dropped = other.bucket
        }
      }
    },
  )

  it("takes a full batch of events from a player never seen, and ten of them at once", () => {
    // `EventsRequest` holds 100 events at most: a batch over the capacity would never go.
    expect(limits.events.capacity).toBeGreaterThanOrEqual(10 * 100)
    for (const rule of Object.values(limits)) expect(rule.capacity).toBeGreaterThanOrEqual(1)
  })
})

// ── the client's address ─────────────────────────────────────────────────────────────────────────────────────────────

const Octet = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))
const Hextet = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0xffff }))

/** An IPv4 address on the internet that is neither Cloudflare's nor a private one. */
const PublicV4 = Schema.Tuple([Schema.Literals([1, 8, 45, 77, 203]), Octet, Octet, Octet])
const v4 = (parts: ReadonlyArray<number>): string => parts.join(".")
/** An IPv6 address outside Cloudflare's ranges and the private ones. */
const PublicV6 = Schema.Tuple([
  Schema.Literals([0x2001, 0x2a00, 0x2604]),
  ...Array.from({ length: 7 }, () => Hextet),
])
const v6 = (groups: ReadonlyArray<number>): string => groups.map((group) => group.toString(16)).join(":")

/** A peer we don't trust, in any of the ways Node writes one. */
const Untrusted = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("v4"), parts: PublicV4 }),
  Schema.Struct({ kind: Schema.Literal("mapped"), parts: PublicV4 }),
  Schema.Struct({ kind: Schema.Literal("v6"), groups: PublicV6 }),
])
const untrusted = (peer: typeof Untrusted.Type): string =>
  peer.kind === "v4" ? v4(peer.parts) : peer.kind === "mapped" ? `::ffff:${v4(peer.parts)}` : v6(peer.groups)

/** Traefik, from where Docker's networks put it. */
const Proxy = Schema.Literals(["10.0.1.5", "172.18.0.3", "192.168.65.2", "127.0.0.1", "::ffff:10.0.1.5", "::1"])
/** An address of Cloudflare's edge, from its published ranges. */
const Edge = Schema.Tuple([Schema.Literals(["104.16", "162.158", "172.64", "2606:4700", "2a06:98c0"]), Octet, Octet])
const edge = ([prefix, a, b]: typeof Edge.Type): string =>
  prefix.includes(":") ? `${prefix}::${a.toString(16)}:${b.toString(16)}` : `${prefix}.${a}.${b}`

/** What a client can write in the headers it sends: an address of its choosing, or something that is none. */
const Forged = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("address"), peer: Untrusted }),
  Schema.Struct({ kind: Schema.Literal("edge"), edge: Edge }),
  Schema.Struct({
    kind: Schema.Literal("junk"),
    text: Schema.Literals(["", "unknown", "1.2.3", "::g", "1.2.3.4:80", "[::1]"]),
  }),
])
const forged = (one: typeof Forged.Type): string =>
  one.kind === "address" ? untrusted(one.peer) : one.kind === "edge" ? edge(one.edge) : one.text

const Headers = Schema.Struct({
  cf: Schema.UndefinedOr(Forged),
  forwarded: Schema.Array(Forged).check(Schema.isMaxLength(3)),
  realIp: Schema.UndefinedOr(Forged),
})
const headersOf = (drawn: typeof Headers.Type, last: string | null = null): Record<string, string> => {
  const entries = [...drawn.forwarded.map(forged), ...(last === null ? [] : [last])]
  return {
    ...(drawn.cf === undefined ? {} : { "cf-connecting-ip": forged(drawn.cf) }),
    ...(entries.length === 0 ? {} : { "x-forwarded-for": entries.join(", ") }),
    ...(drawn.realIp === undefined ? {} : { "x-real-ip": forged(drawn.realIp) }),
  }
}

/** An address as `clientIpOf` writes it. */
const canonical = (text: string): string | null => {
  const address = addressOf(text)
  return address === null ? null : textOf(address)
}

describe("clientIpOf", () => {
  it.prop(
    "takes the socket's address from a peer we don't trust, whatever its headers say",
    [Untrusted, Headers],
    ([peer, drawn]) => {
      const socket = untrusted(peer)
      expect(clientIpOf(publicTrust, headersOf(drawn), socket)).toBe(canonical(socket))
    },
  )

  it.prop(
    "through our proxy, takes the last X-Forwarded-For entry: never one before it, nor a CF-Connecting-IP from outside",
    [Proxy, Untrusted, Headers],
    ([proxy, peer, drawn]) => {
      const reached = untrusted(peer)
      expect(clientIpOf(publicTrust, headersOf(drawn, reached), proxy)).toBe(canonical(reached))
    },
  )

  it.prop(
    "through our proxy from Cloudflare's edge, takes CF-Connecting-IP, or the edge when it names no address",
    [Proxy, Edge, Headers],
    ([proxy, from, drawn]) => {
      const headers = headersOf(drawn, edge(from))
      const named = canonical(headers["cf-connecting-ip"] ?? "")
      expect(clientIpOf(publicTrust, headers, proxy)).toBe(named ?? canonical(edge(from)))
    },
  )

  it.prop("takes our proxy's own address when it forwards nothing it can read", [Proxy, Headers], ([proxy, drawn]) => {
    const headers = { ...headersOf(drawn), "x-forwarded-for": "not an address" }
    expect(clientIpOf(publicTrust, headers, proxy)).toBe(canonical(proxy))
  })

  it("names nobody without a socket address", () => {
    expect(clientIpOf(publicTrust, { "cf-connecting-ip": "198.51.100.1" }, null)).toBeNull()
    expect(limitKeyOf(null)).toBe("unknown")
  })

  it("reads Cloudflare's published ranges, and only them", () => {
    const isCloudflare = (text: string) => {
      const address = addressOf(text)
      return address !== null && publicTrust.cloudflare.some((range) => isIn(address, range))
    }
    expect(publicTrust.cloudflare).toHaveLength(22)
    const inside = ["173.245.48.1", "104.23.255.255", "131.0.75.255", "2400:cb00::1", "2a06:98c7:ffff::1"]
    const outside = ["173.245.64.0", "104.15.255.255", "8.8.8.8", "2a06:98c8::", "::ffff:8.8.8.8"]
    expect(inside.every(isCloudflare)).toBe(true)
    expect(outside.some(isCloudflare)).toBe(false)
    expect(isCloudflare("::ffff:104.16.0.1")).toBe(true)
  })
})

describe("addresses", () => {
  it.prop("spell one address one way: an IPv4 address mapped into IPv6 is the IPv4 address", [PublicV4], ([parts]) => {
    expect(canonical(`::ffff:${v4(parts)}`)).toBe(v4(parts))
    expect(canonical(`::FFFF:${v4(parts)}`)).toBe(v4(parts))
  })

  it.prop("read every way of writing an IPv6 address as one", [PublicV6], ([groups]) => {
    const full = groups.map((group) => group.toString(16).padStart(4, "0")).join(":")
    expect(canonical(full)).toBe(v6(groups))
    expect(canonical(full.toUpperCase())).toBe(v6(groups))
    expect(canonical(`${v6(groups)}%eth0`)).toBe(v6(groups))
    const zeroed = [...groups.slice(0, 3), 0, 0, ...groups.slice(5)]
    const compressed = `${v6(zeroed.slice(0, 3))}::${v6(zeroed.slice(5))}`
    expect(canonical(compressed)).toBe(v6(zeroed))
  })

  it.prop(
    "key an IPv6 client by its /64, and an IPv4 client by its address",
    [PublicV6, PublicV6, PublicV4],
    ([one, other, parts]) => {
      const sameNet = [...one.slice(0, 4), ...other.slice(4)]
      expect(limitKeyOf(v6(sameNet))).toBe(limitKeyOf(v6(one)))
      expect(limitKeyOf(v6(other)) === limitKeyOf(v6(one))).toBe(other.slice(0, 4).join() === one.slice(0, 4).join())
      expect(limitKeyOf(v4(parts))).toBe(v4(parts))
    },
  )
})

// ── the limits on the routes ─────────────────────────────────────────────────────────────────────────────────────────

const ada = { id: 1, login: "Ada", name: "Ada Lovelace" }

/** GitHub as the test fills it, counting each time it is asked: `ada-token` is Ada's, any other token none. */
const countedGitHub = (asked: { count: number }) =>
  Layer.succeed(
    GitHub,
    GitHub.of({
      user: (token) =>
        Effect.sync(() => {
          asked.count += 1
          return Redacted.value(token) === "ada-token" ? Option.some(ada) : Option.none()
        }),
    }),
  )

const withPublic = <A, E, R>(effect: Effect.Effect<A, E, R>, asked = { count: 0 }) =>
  effect.pipe(Effect.provide(testPublicServices({ signup: "open", allowedLogins: "", adminGithubIds: [] }, countedGitHub(asked))))

/** A request from the socket address `socket`, with `headers` beside it. */
const from = (socket: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
  new Request(`http://pathofdev.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-test-socket": socket, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const bodyOf = (response: Response) => Effect.promise((): Promise<unknown> => response.json())
const isApiError = Schema.is(ApiError)

/** Sends `request()` `times` over, and the statuses it got. */
const repeat = (handle: (request: Request) => Effect.Effect<Response>, times: number, request: () => Request) =>
  Effect.forEach(Array.from({ length: times }), () => Effect.map(handle(request()), (response) => response.status))

describe("the limits per client address", () => {
  it.effect("answer a page past the limit 429, saying when; a forged header from the same peer changes nothing", () =>
    withPublic(
      Effect.gen(function* () {
        const handle = yield* addressedWebHandler
        const page = (socket: string, headers: Record<string, string> = {}) => from(socket, "/u/-nobody", headers)
        const statuses = yield* repeat(handle, limits.pages.capacity, () => page("203.0.113.7"))
        expect(new Set(statuses)).toEqual(new Set([404]))
        const refused = yield* handle(page("203.0.113.7"))
        expect(refused.status).toBe(429)
        expect(refused.headers.get("retry-after")).toBe("1")
        const body = yield* bodyOf(refused)
        expect(body).toMatchObject({ _tag: "RateLimited", code: "rate_limited", retryAfterMs: limits.pages.everyMs })
        expect(isApiError(body)).toBe(true)
        // The same peer, claiming to be someone else.
        const claims = {
          "cf-connecting-ip": "198.51.100.1",
          "x-forwarded-for": "198.51.100.2",
          "x-real-ip": "198.51.100.3",
        }
        expect((yield* handle(page("203.0.113.7", claims))).status).toBe(429)
        expect((yield* handle(page("::ffff:203.0.113.7"))).status).toBe(429)
        // Another peer has a bucket of its own; a second later the first has one more page.
        expect((yield* handle(page("203.0.113.8"))).status).toBe(404)
        yield* TestClock.adjust(limits.pages.everyMs)
        expect(yield* repeat(handle, 2, () => page("203.0.113.7"))).toEqual([404, 429])
      }),
    ))

  it.effect("key a request through Cloudflare by CF-Connecting-IP, and one round Cloudflare by its own address", () =>
    withPublic(
      Effect.gen(function* () {
        const handle = yield* addressedWebHandler
        const viaCloudflare = (client: string) =>
          from("10.0.1.5", "/u/-nobody", { "x-forwarded-for": `${client}, 104.16.0.9`, "cf-connecting-ip": client })
        yield* repeat(handle, limits.pages.capacity, () => viaCloudflare("198.51.100.9"))
        expect((yield* handle(viaCloudflare("198.51.100.9"))).status).toBe(429)
        expect((yield* handle(viaCloudflare("198.51.100.10"))).status).toBe(404)
        // Straight to the server's address, past Cloudflare: its CF-Connecting-IP is its own to make up.
        const around = (claimed: string) =>
          from("10.0.1.5", "/u/-nobody", { "x-forwarded-for": `${claimed}, 203.0.113.50`, "cf-connecting-ip": claimed })
        yield* repeat(handle, limits.pages.capacity, () => around("198.51.100.20"))
        expect((yield* handle(around("198.51.100.21"))).status).toBe(429)
      }),
    ))

  it.effect("answer a sign-in past the limit 429 before GitHub is asked", () => {
    const asked = { count: 0 }
    return withPublic(
      Effect.gen(function* () {
        const handle = yield* addressedWebHandler
        const signIn = () => from("203.0.113.7", "/v1/auth/github", {}, { githubToken: "not-a-token", timezone: "UTC" })
        const statuses = yield* repeat(handle, limits.auth.capacity, signIn)
        expect(new Set(statuses)).toEqual(new Set([401]))
        expect(asked.count).toBe(limits.auth.capacity)
        const refused = yield* handle(signIn())
        expect(refused.status).toBe(429)
        expect(refused.headers.get("retry-after")).toBe(String(limits.auth.everyMs / 1000))
        expect(asked.count).toBe(limits.auth.capacity)
        // Signing out counts against the same bucket.
        const signOut = new Request("http://pathofdev.test/v1/auth/logout", {
          method: "POST",
          headers: { "x-test-socket": "203.0.113.7" },
        })
        expect((yield* handle(signOut)).status).toBe(429)
        // The router matches a path in any case, with its slashes doubled or its letters percent-encoded: so does the
        // limit.
        for (const path of ["/V1/Auth/github", "//v1/auth/github", "/v1/%61uth/github", "/v1//auth/github"]) {
          const spelt = from("203.0.113.7", path, {}, { githubToken: "not-a-token", timezone: "UTC" })
          expect((yield* handle(spelt)).status).toBe(429)
        }
        expect(asked.count).toBe(limits.auth.capacity)
      }),
      asked,
    )
  })

  it.effect("count a page the router matches however its path is spelt", () =>
    withPublic(
      Effect.gen(function* () {
        const handle = yield* addressedWebHandler
        yield* repeat(handle, limits.pages.capacity, () => from("203.0.113.7", "/u/-nobody"))
        for (const path of ["/U/-nobody", "//u/-nobody", "/%75/-nobody"]) {
          expect((yield* handle(from("203.0.113.7", path))).status).toBe(429)
        }
      }),
    ))
})

describe("the limits per player", () => {
  /** A batch of `size` events of a type no server knows: each is turned away at the edge, so the batch is cheap. */
  const unknown = (size: number) => ({
    events: Array.from({ length: size }, (_, i) => ({ id: `x${i}`, type: "future.thing" })),
  })

  const signedIn = (handle: (request: Request) => Effect.Effect<Response>, socket: string) =>
    Effect.gen(function* () {
      const response = yield* handle(from(socket, "/v1/auth/github", {}, { githubToken: "ada-token", timezone: "UTC" }))
      expect(response.status).toBe(200)
      const body = yield* bodyOf(response)
      const token = typeof body === "object" && body !== null && "token" in body ? String(body.token) : ""
      return { authorization: `Bearer ${token}` }
    })

  it.effect("answer the events past the player's limit 429, from any address, and write nothing", () =>
    withPublic(
      Effect.gen(function* () {
        const handle = yield* addressedWebHandler
        const auth = yield* signedIn(handle, "203.0.113.7")
        const batches = limits.events.capacity / 100
        const statuses = yield* repeat(handle, batches, () => from("203.0.113.7", "/v1/events", auth, unknown(100)))
        expect(new Set(statuses)).toEqual(new Set([200]))
        const before = yield* dump
        const batch = { events: [prompt(8), ...unknown(99).events] }
        const refused = yield* handle(from("203.0.113.8", "/v1/events", auth, batch))
        expect(refused.status).toBe(429)
        const body = yield* bodyOf(refused)
        const wait = 100 * limits.events.everyMs
        expect(body).toMatchObject({ _tag: "RateLimited", code: "rate_limited", retryAfterMs: wait })
        expect(isApiError(body)).toBe(true)
        expect(refused.headers.get("retry-after")).toBe(String(wait / 1000))
        expect(yield* dump).toEqual(before)
        // A smaller batch fits what came back meanwhile, and the wait it was told is enough for the whole one.
        yield* TestClock.adjust(limits.events.everyMs)
        expect((yield* handle(from("203.0.113.7", "/v1/events", auth, unknown(1)))).status).toBe(200)
        yield* TestClock.adjust(100 * limits.events.everyMs)
        expect((yield* handle(from("203.0.113.7", "/v1/events", auth, unknown(100)))).status).toBe(200)
      }),
    ))

  it.effect("answer a command past the player's limit on writes 429, and write nothing", () =>
    withPublic(
      Effect.gen(function* () {
        const handle = yield* addressedWebHandler
        const auth = yield* signedIn(handle, "203.0.113.7")
        const empty = () => from("203.0.113.7", "/v1/events", auth, { events: [] })
        const statuses = yield* repeat(handle, limits.writes.capacity, empty)
        expect(new Set(statuses)).toEqual(new Set([200]))
        const before = yield* dump
        const refused = yield* handle(from("203.0.113.7", "/v1/commands", auth, hatch()))
        expect(refused.status).toBe(429)
        expect(yield* bodyOf(refused)).toMatchObject({ _tag: "RateLimited", retryAfterMs: limits.writes.everyMs })
        expect(yield* dump).toEqual(before)
        // The stream and the session are not limited.
        const opened = yield* handle(from("203.0.113.7", "/v1/sessions", auth, { sessionId: session }))
        expect(opened.status).toBe(200)
      }),
    ))
})

describe("the local server", () => {
  it.effect("takes every batch, however many, as its one player is the machine's own", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        const batch = { events: Array.from({ length: 100 }, (_, i) => ({ id: `x${i}`, type: "future.thing" })) }
        for (let sent = 0; sent < (2 * limits.events.capacity) / 100; sent++) {
          const answered = yield* api.sendEvents({ payload: batch })
          expect(answered.results).toHaveLength(100)
        }
      }),
    ))
})
