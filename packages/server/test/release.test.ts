import { it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { readFileSync } from "node:fs"
import { describe, expect } from "vitest"
import type { GithubUser } from "../src/index.ts"
import { BadManifest, latestModVersionOf, modManifestUrl, modVersionOf, readModVersion } from "../src/index.ts"
import {
  client,
  fakeGitHub,
  json,
  publicWebHandler,
  request,
  session,
  signIn,
  testPublicServices,
  withServer,
} from "./fixtures.ts"

// The mod's latest version, as the public server tells it (release.ts): read from the mod's manifest at boot, and
// answered with each session it opens, never with the snapshot the companion reads. A local server tells none.
//
//   plugin.json ─▶ readModVersion ─▶ publicServices(latestModVersion) ─▶ POST /v1/sessions { latestModVersion }
//                                                                     └▶ GET /v1/snapshot: left out

const ada: GithubUser = { id: 1, login: "Ada", name: "Ada Lovelace" }

const withPublic = (latestModVersion: string | null) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(
        testPublicServices({ signup: "open", allowedLogins: "", adminGithubIds: [], latestModVersion }, fakeGitHub([ada])),
      ),
    )

describe("the mod's manifest", () => {
  it("names its version, a semantic one", () => {
    expect(modVersionOf('{"name":"pathofdev","version":"0.10.0"}')).toBe("0.10.0")
    expect(modVersionOf('{"version":"1.2.3-beta.1+build.5"}')).toBe("1.2.3-beta.1+build.5")
  })

  it("names none when it isn't JSON, has no version, or one that isn't semantic", () => {
    for (const text of ["", "not json", "[]", "null", '{"name":"pathofdev"}', '{"version":10}', '{"version":"1.2"}', '{"version":"01.2.3"}', '{"version":"v1.2.3"}'])
      expect({ text, version: modVersionOf(text) }).toEqual({ text, version: null })
  })

  it.effect("is read where the repo keeps it, naming the version plugin.json has", () =>
    Effect.gen(function* () {
      const { version } = JSON.parse(readFileSync(modManifestUrl, "utf8")) as { version: string }
      expect(yield* readModVersion()).toBe(version)
    }))

  it.effect("stops the boot, named, when it is missing", () =>
    Effect.gen(function* () {
      const missing = new URL("./no-such-manifest.json", import.meta.url)
      const exit = yield* Effect.exit(readModVersion(missing))
      expect(exit).toEqual(Exit.fail(new BadManifest({ path: missing.pathname })))
      expect(new BadManifest({ path: missing.pathname }).message).toContain("no-such-manifest.json")
    }))
})

describe("the mod's latest version", () => {
  it("is told by an online server alone, whatever a local one's options say", () => {
    expect(latestModVersionOf("online", { latestModVersion: "0.10.0" })).toBe("0.10.0")
    expect(latestModVersionOf("online", {})).toBeNull()
    expect(latestModVersionOf("local", { latestModVersion: "0.10.0" })).toBeNull()
  })

  it.effect("rides the public server's session answer, and not its snapshot", () =>
    Effect.gen(function* () {
      const handle = yield* publicWebHandler
      const { bearer } = yield* signIn(handle, ada)
      const opened = yield* json(yield* handle(request("/v1/sessions", "POST", bearer, { sessionId: session, presence: true })))
      expect(opened.latestModVersion).toBe("0.10.0")
      const shot = yield* json(yield* handle(request("/v1/snapshot", "GET", bearer)))
      expect(Object.keys(shot).sort()).toEqual(["minClientVersion", "rules", "snapshot"])
    }).pipe(withPublic("0.10.0")))

  it.effect("is left out of a public server's session answer when it tells none", () =>
    Effect.gen(function* () {
      const handle = yield* publicWebHandler
      const { bearer } = yield* signIn(handle, ada)
      const opened = yield* json(yield* handle(request("/v1/sessions", "POST", bearer, { sessionId: session })))
      expect(opened).not.toHaveProperty("latestModVersion")
    }).pipe(withPublic(null)))

  it.effect("is left out of a local server's session answer", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        const opened = yield* api.openSession({ payload: { sessionId: session } })
        expect(opened).not.toHaveProperty("latestModVersion")
      }),
    ))
})
