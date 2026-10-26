import type {
  AchievementDef,
  Criterion,
  ImportedHistory,
  Player as PlayerType,
  Privacy,
  ProfileSection,
  QualityDimension,
  Rarity,
  Snapshot,
} from "@pathofdev/schema"
import type { BadgeProgress, Gauge } from "@pathofdev/engine"
import { happyBonusPct } from "@pathofdev/engine"
import { isGithubLogin, isShown, Player, privacyOf, profileUrlOf } from "@pathofdev/schema"
import { Cause, Context, Effect, Layer, Option, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient, SqlSchema } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { Allowlist } from "./auth/allowlist.ts"
import { rules } from "./game.ts"
import { limitAddress, limitedResponse, limits } from "./limits.ts"
import { History } from "./history.ts"
import { gaugeOf, notFoundPage, pageContentType, pageHeaders, profilePage, unavailablePage } from "./pages.ts"
import type { ProfileRead } from "./players.ts"
import { playerColumns, Players } from "./players.ts"
import { RateLimiter } from "./rate-limit.ts"

// A player's public page, `pathof.dev/u/<login>`: read-only, no sign-in, rendered from their snapshot. Traefik sends
// `/u/*` on pathof.dev to the public server, its prefix kept; everything else there is the landing page.
//
//   GET /u/*, first ─ over the client address's limit (limits.ts) ─▶ 429, nothing read
//   GET /u/<anything deeper> ────────────────────▶ 404
//   GET /u/:login
//     ├─ not a GitHub login ─────────────────────▶ 404
//     ├─ Profiles.byLogin: no player holds it ───▶ 404   one query, on lower(github_login)
//     ├─ privacyOf(profile) is not public ───────▶ 404   checked before the save is read, so a private player's
//     ├─ signup closed, not on the beta list ────▶ 404     save, newer or broken, never shows through a 503
//     └─ Players.profile: the snapshot, and how far each locked badge is; History.read only while it is shown
//          ├─ PlayerGone: deleted since ─────────▶ 404
//          ├─ anything else fails ───────────────▶ 503, logged: a database down never looks like a missing page
//          └─▶ profileOf(read, privacy, history) ▶ 200 profilePage   only the sections shown, allow-listed
//
// Every 404 is the same constant page with the same headers, whatever the reason. Pages are never cached
// (`no-store`), so a hide, a private or a delete takes effect on the next view.

/** Where the public pages live: `${origin}/u/<login>`. */
export class ProfileOrigin extends Context.Service<ProfileOrigin, { readonly origin: string }>()(
  "pathofdev/ProfileOrigin",
) {
  static readonly layer = (origin: string) => Layer.succeed(ProfileOrigin, ProfileOrigin.of({ origin }))
}

export const defaultProfileOrigin = "https://pathof.dev"

/** `raw` as an origin the pages can live at (http or https, no path, no trailing slash), or null. */
export const profileOriginOf = (raw: string): string | null => {
  if (!URL.canParse(raw)) return null
  const url = new URL(raw)
  return (url.protocol === "https:" || url.protocol === "http:") && url.origin === raw ? raw : null
}

/**
 * What a public page shows, and nothing else: the header, and each section the player shows. A hidden section has no
 * key at all. Built only by `profileOf`, field by field, so a field the snapshot gains never reaches a page unnamed.
 */
export interface PublicProfile {
  readonly login: string
  readonly character: {
    readonly name: string
    readonly level: number
    readonly title: string
    readonly glyph: string
    readonly prestige: number
    readonly xp: { readonly total: number; readonly intoLevel: number; readonly forNextLevel: number }
  }
  readonly badges?: PublicBadges
  /** Null while it is an egg. */
  readonly pet?: {
    readonly name: string
    /** As the rules name it: "Fox". */
    readonly species: string
    readonly form: number
    readonly mood: number
    /** The XP bonus its mood gives now: 0 unless it is happy. */
    readonly xpBonusPct: number
  } | null
  readonly streak?: { readonly days: number; readonly best: number; readonly restDaysLeftThisWeek: number }
  readonly stats?: {
    readonly graded: number
    readonly averageScore: number
    readonly best: number
    readonly dimensions: Readonly<Record<QualityDimension, number>>
    /** The average context peak, in percent. */
    readonly contextPeak: number
  }
  /** Shown only once the player shows it, and only when an import brought one. */
  readonly history?: PublicHistory
}

/** The counts an import brought from before Path of Dev, as a page shows them: when it was taken left out. */
export interface PublicHistory {
  readonly prompts: number
  readonly sessions: number
  readonly projects: number
  readonly days: number
  readonly longestStreak: number
  readonly toolCalls: number
  readonly testRuns: number
  readonly commits: number
  readonly firstDay: string | null
  readonly lastDay: string | null
}

/** Every badge the rules define, the player's earned ones counted: "`earned` of `of`". */
export interface PublicBadges {
  readonly earned: number
  readonly of: number
  /** The earned, newest first, then the locked, the closest first. */
  readonly list: ReadonlyArray<PublicBadge>
}

/** A badge as a page draws it, from the rules: earned at `unlockedAt`, or locked. */
export interface PublicBadge {
  readonly id: string
  readonly name: string
  readonly about: string
  readonly rarity: Rarity
  readonly glyph: string
  readonly criterion: Criterion
  readonly unlockedAt: string | null
  /** How far a locked badge is: null once earned, and while the player hides a section it would tell (`sectionsOf`). */
  readonly gauges: ReadonlyArray<Gauge> | null
}

/** How close a locked badge is, 0 to 1, for its place in the list; an average's gauges don't add up to one. */
const closeness = (badge: PublicBadge): number =>
  badge.gauges === null ? 0 : (gaugeOf(badge.criterion, badge.gauges).share ?? 0)

/**
 * The sections a locked badge's progress tells: the stats always (its counts), and the streak's days or whether the
 * pet hatched for the badges that read them. It shows only while every one of them is shown.
 */
const sectionsOf = (criterion: Criterion): ReadonlyArray<ProfileSection> => {
  if (criterion.kind !== "count") return ["stats"]
  if (criterion.of.kind === "streak") return ["stats", "streak"]
  return criterion.of.kind === "hatched" ? ["stats", "pet"] : ["stats"]
}

/**
 * The badges a page shows: every one the rules define, earned or locked. An id the player holds that the rules no
 * longer define is left out, and counted nowhere. A locked badge's progress shows only while `shown` holds every
 * section it would tell.
 */
export const badgesOf = (
  defs: ReadonlyArray<AchievementDef>,
  held: Snapshot["achievements"],
  progress: ReadonlyArray<BadgeProgress>,
  shown: (section: ProfileSection) => boolean,
): PublicBadges => {
  const unlocked = new Map(held.map((one) => [one.id, one.unlockedAt]))
  const measured = new Map(progress.map((one) => [one.id, one.gauges]))
  const all = defs.map((def): PublicBadge => {
    const unlockedAt = unlocked.get(def.id) ?? null
    return {
      id: def.id,
      name: def.name,
      about: def.about,
      rarity: def.rarity,
      glyph: def.glyph,
      criterion: def.criterion,
      unlockedAt,
      gauges: unlockedAt === null && sectionsOf(def.criterion).every(shown) ? (measured.get(def.id) ?? null) : null,
    }
  })
  // Sorts are stable: a tie keeps the rules' order.
  const earned = all.filter((badge) => badge.unlockedAt !== null)
    .sort((a, b) => Date.parse(b.unlockedAt ?? "") - Date.parse(a.unlockedAt ?? ""))
  const locked = all.filter((badge) => badge.unlockedAt === null).sort((a, b) => closeness(b) - closeness(a))
  return { earned: earned.length, of: defs.length, list: [...earned, ...locked] }
}

const speciesName = (species: string): string => rules.pet.species.find((one) => one.id === species)?.name ?? species

/** The history a page shows, field by field, the tool calls summed. */
export const publicHistoryOf = (history: ImportedHistory): PublicHistory => ({
  prompts: history.prompts,
  sessions: history.sessions,
  projects: history.projects,
  days: history.days,
  longestStreak: history.longestStreak,
  toolCalls: Object.values(history.tools).reduce((sum, count) => sum + count, 0),
  testRuns: history.testRuns,
  commits: history.commits,
  firstDay: history.firstDay,
  lastDay: history.lastDay,
})

/**
 * What `login`'s page shows of their save under `privacy`: the allow-list between a save and the web. `history` is
 * the import kept, if any, which the page shows only while the player shows it.
 */
export const profileOf = (
  login: string,
  read: ProfileRead,
  privacy: Privacy,
  history: ImportedHistory | null = null,
): PublicProfile => {
  const { snapshot, badgeProgress } = read
  const { character, pet, stats } = snapshot
  const shown = (section: ProfileSection) => isShown(privacy, section)
  return {
    login,
    character: {
      name: character.name,
      level: character.level,
      title: character.title,
      glyph: character.glyph,
      prestige: character.prestige,
      xp: { total: character.xp.total, intoLevel: character.xp.intoLevel, forNextLevel: character.xp.forNextLevel },
    },
    ...(shown("badges")
      ? { badges: badgesOf(rules.achievements, snapshot.achievements, badgeProgress, shown) }
      : {}),
    ...(shown("pet")
      ? {
        pet: pet === null ? null : {
          name: pet.name,
          species: speciesName(pet.species),
          form: pet.form,
          mood: pet.mood,
          xpBonusPct: happyBonusPct(pet.mood, rules),
        },
      }
      : {}),
    ...(shown("streak")
      ? {
        streak: {
          days: character.streak.days,
          best: character.streak.best,
          restDaysLeftThisWeek: character.streak.restDaysLeftThisWeek,
        },
      }
      : {}),
    ...(shown("stats")
      ? {
        stats: {
          graded: stats.prompts.graded,
          averageScore: stats.prompts.averageScore,
          best: stats.grades.best,
          dimensions: { ...stats.grades.dimensions },
          contextPeak: stats.contextPeak.average,
        },
      }
      : {}),
    ...(shown("history") && history !== null ? { history: publicHistoryOf(history) } : {}),
  }
}

const Found = Schema.Struct({ ...Player.fields, profile: Schema.Unknown })

export class Profiles extends Context.Service<
  Profiles,
  {
    /** The player who holds `login` now, in any case, and their stored profile. */
    readonly byLogin: (login: string) => Effect.Effect<
      Option.Option<{ readonly player: PlayerType; readonly profile: unknown }>,
      Schema.SchemaError | SqlError
    >
  }
>()("pathofdev/Profiles") {
  static readonly layer = Layer.effect(
    Profiles,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const find = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: Found,
        execute: (login) => sql`SELECT ${playerColumns(sql)}, profile FROM players WHERE lower(github_login) = lower(${login})`,
      })
      return Profiles.of({
        byLogin: (login) => Effect.map(find(login), Option.map(({ profile, ...player }) => ({ player, profile }))),
      })
    }),
  )
}

const page = (body: string, status: number) =>
  HttpServerResponse.text(body, { status, contentType: pageContentType, headers: pageHeaders })

const notFound = page(notFoundPage, 404)

/** `GET /u/:login`, on the public server only. */
export const ProfilePages = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const profiles = yield* Profiles
    const players = yield* Players
    const allowlist = yield* Allowlist
    const { origin } = yield* ProfileOrigin
    const limiter = yield* RateLimiter
    const history = yield* History

    /** `page`, once the client address is within its limit on pages: over it, the 429, and nothing read. */
    const limited = <E, R>(page: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
      Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
        Effect.matchEffect(limitAddress(limiter, request, limits.pages), {
          onFailure: (refused) => Effect.succeed(limitedResponse(refused)),
          onSuccess: () => page,
        }))

    const pageOf = (raw: string) =>
      Effect.gen(function* () {
        if (!isGithubLogin(raw)) return notFound
        const found = yield* profiles.byLogin(raw)
        if (Option.isNone(found)) return notFound
        const { player, profile } = found.value
        const privacy = privacyOf(profile)
        const login = player.githubLogin
        if (!privacy.public || login === null || !(yield* allowlist.allows(player))) return notFound
        const read = yield* players.profile(player)
        // Read only while shown: a hidden history never leaves its table for a page.
        const kept = isShown(privacy, "history") ? Option.getOrNull(yield* history.read(player.id)) : null
        return page(profilePage(profileOf(login, read, privacy, kept), profileUrlOf(origin, login)), 200)
      }).pipe(
        Effect.catchTag("PlayerGone", () => Effect.succeed(notFound)),
        // A request cut short (the viewer left, the server stopping) stays interrupted: no 503, nothing logged.
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.as(Effect.logWarning("A profile page could not be read", cause), page(unavailablePage, 503))
        ),
      )

    const byLogin = Effect.flatMap(HttpRouter.params, ({ login }) => pageOf(login ?? ""))
    yield* router.add("GET", "/u/:login", limited(byLogin))
    // Any other path under /u (`/u`, `/u/a/b`) is the same 404 page, not the router's bare one.
    yield* router.add("GET", "/u/*", limited(Effect.succeed(notFound)))
  })
)
