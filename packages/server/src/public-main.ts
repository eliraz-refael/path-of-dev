import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { publicConfigOf, publicServer } from "./public.ts"
import { readModVersion } from "./release.ts"

// Starts the public server in the foreground, as its container does: the settings from the environment and the mod's
// version from its manifest, a missing one stopping it by name, then the migrations, then it listens until it is told
// to stop.

const boot = Effect.gen(function* () {
  const config = yield* publicConfigOf(process.env)
  const latest = yield* readModVersion()
  yield* Effect.logInfo(`Telling each session the mod's latest version is ${latest}`)
  return publicServer(config, latest)
})

Layer.launch(Layer.unwrap(boot)).pipe(NodeRuntime.runMain)
