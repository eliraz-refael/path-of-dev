import { Context, Data, Effect, Layer } from "effect"
import { readFile } from "node:fs/promises"

// The mod's latest version, which the public server tells each session it opens, so a mod behind it can say so. The
// public server is built from the same repo as the marketplace that offers the mod, and a merge to main deploys it as
// the marketplace starts offering the new mod: so the version in the mod's manifest beside it, read once at boot, is
// the one players can update to. The image keeps the manifest where the repo does, relative to the server's code.
//
//   packages/mod/.claude-plugin/plugin.json ─▶ readModVersion (boot) ─▶ ModRelease ─▶ POST /v1/sessions latestModVersion
//
// A local server runs from a clone, which says nothing of what the marketplace offers: it tells no version.

/** The mod's latest version, as this server tells it; null on a server that tells none. */
export class ModRelease extends Context.Service<ModRelease, { readonly latest: string | null }>()(
  "pathofdev/ModRelease",
) {
  static readonly layer = (latest: string | null) => Layer.succeed(ModRelease, ModRelease.of({ latest }))
}

/** The mod's manifest, where the repo keeps it beside the server: from `src/` and from `dist/` alike. */
export const modManifestUrl = new URL("../../mod/.claude-plugin/plugin.json", import.meta.url)

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** The `version` a manifest's text names, when it is a semantic version; null for anything else. */
export const modVersionOf = (text: string): string | null => {
  let manifest: unknown
  try {
    manifest = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof manifest !== "object" || manifest === null || !("version" in manifest)) return null
  const { version } = manifest
  return typeof version === "string" && semver.test(version) ? version : null
}

export class BadManifest extends Data.TaggedError("BadManifest")<{ readonly path: string }> {
  override get message() {
    return `The mod's manifest at ${this.path} can't be read, or names no version: the public server needs it to start`
  }
}

/** The version the mod's manifest at `url` names; a manifest missing, unreadable or with no version stops the boot. */
export const readModVersion = (url: URL = modManifestUrl): Effect.Effect<string, BadManifest> => {
  const bad = new BadManifest({ path: url.pathname })
  return Effect.tryPromise({ try: () => readFile(url, "utf8"), catch: () => bad }).pipe(
    Effect.flatMap((text) => {
      const version = modVersionOf(text)
      return version === null ? Effect.fail(bad) : Effect.succeed(version)
    }),
  )
}
