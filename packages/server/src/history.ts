import type { HistoryCounts, ImportedHistory } from "@pathofdev/schema"
import { HistoryCounts as Counts, ImportedHistory as Imported } from "@pathofdev/schema"
import { Context, Effect, Layer, Option, Predicate, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { PlayerGone } from "./writer.ts"

// The player's history from before Path of Dev (schema history.ts), kept apart from the game: a row of its own in
// `player_history`, which no engine, replay or log reads. An import replaces the row whole, in one statement, so two
// imports at once leave one of them, never a mix.
//
//   read(player)              ─▶ SELECT counts, imported_at ─▶ ImportedHistory, or none (none kept, or a row this
//                                                               build can't read: a page then shows no section)
//   replace(player, counts, now) ─▶ INSERT … SELECT FROM players WHERE id … FOR KEY SHARE ON CONFLICT … DO UPDATE
//                                     └─ no players row (deleted meanwhile) ─▶ PlayerGone
//
// FOR KEY SHARE waits out a delete under way (account.ts holds the players row FOR UPDATE), then finds no row: a
// PlayerGone, not the foreign key's violation it would meet had it read the row before the delete committed.

const Row = Schema.Struct({ counts: Schema.Unknown, imported_at: Schema.String })
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row))
const decodeImported = Schema.decodeUnknownOption(Imported)
const encodeCounts = Schema.encodeSync(Counts)

export class History extends Context.Service<
  History,
  {
    /** The history kept for the player, if any. */
    readonly read: (playerId: string) => Effect.Effect<Option.Option<ImportedHistory>, SqlError | Schema.SchemaError>
    /** Keeps `counts` as the player's history from now on, in place of any kept before. */
    readonly replace: (
      playerId: string,
      counts: HistoryCounts,
      now: string,
    ) => Effect.Effect<ImportedHistory, SqlError | Schema.SchemaError | PlayerGone>
  }
>()("pathofdev/History") {
  static readonly layer = Layer.effect(
    History,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      /** A stored row as the history it holds, field by field: anything else the jsonb holds stays in it. */
      const importedOf = (row: typeof Row.Type): Option.Option<ImportedHistory> =>
        decodeImported({ ...(Predicate.isObject(row.counts) ? row.counts : {}), importedAt: row.imported_at })

      const read = (playerId: string) =>
        Effect.map(
          Effect.flatMap(
            sql`SELECT counts, imported_at FROM player_history WHERE player_id = ${playerId}`,
            decodeRows,
          ),
          (rows) => (rows[0] === undefined ? Option.none() : importedOf(rows[0])),
        )

      const replace = (playerId: string, counts: HistoryCounts, now: string) =>
        Effect.gen(function* () {
          const encoded = JSON.stringify(encodeCounts(counts))
          const rows = yield* sql`
            INSERT INTO player_history (player_id, counts, imported_at)
            SELECT id, ${encoded}::jsonb, ${now} FROM players WHERE id = ${playerId} FOR KEY SHARE
            ON CONFLICT (player_id) DO UPDATE SET counts = excluded.counts, imported_at = excluded.imported_at
            RETURNING player_id
          `
          if (rows.length === 0) return yield* new PlayerGone({ playerId })
          return { ...counts, importedAt: now }
        })

      return History.of({ read, replace })
    }),
  )
}
