import { starterCatalog, starterRules } from "@pathofdev/engine"
import type { ItemDef, RulesConfig } from "@pathofdev/schema"
import { achievementsIssue, catalogIssue } from "@pathofdev/schema"
import { Clock, Context, Effect, Layer } from "effect"

// The rules the proof of concept runs under. Publishing rules versions (rules_versions, rules_head) comes later; for
// now every input runs under the starter config and catalogue.

/**
 * The catalogue as the rules allow it: a sigil outside its rarity's range would be held to the range unseen, and a
 * badge the catalogue can't satisfy would never unlock, so the server refuses to start on either instead.
 */
export const checkedRules = (rules: RulesConfig, catalog: ReadonlyArray<ItemDef>): ReadonlyArray<ItemDef> => {
  const issue = catalogIssue(rules.prompt.sigilMultiplier, catalog) ?? achievementsIssue(rules.achievements, catalog)
  if (issue !== undefined) throw new Error(`The catalogue doesn't fit the rules: ${issue}`)
  return catalog
}

export const rules = starterRules
export const catalog = checkedRules(rules, starterCatalog)
/** The oldest mod this server talks to. */
export const minClientVersion = "0.0.0"
/** The first version of each input's raw JSON in the log; upcasters key on it once the shapes change. */
export const inputSchemaVersion = 1

/**
 * Dev mode: the sandbox that takes the dev commands. Only the local server turns it on, from `PATHOFDEV_DEV=1`, and
 * only over a home of its own; an online server can't (`devModeOf`), so the engine refuses them there.
 */
export class DevMode extends Context.Service<DevMode, { readonly isOn: boolean }>()("pathofdev/DevMode") {
  static readonly layer = (isOn: boolean) => Layer.succeed(DevMode, { isOn })
}

/** The clock's time as the ISO string the engine and the log read. */
export const nowIso: Effect.Effect<string> = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString())
