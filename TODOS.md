# TODOs

Work deferred from the plan for Path of Dev online v1 (the closed beta), reviewed on 2026-10-13. Each entry says what
the work is, why it matters, where things stand and what it waits on.

## Before opening signup

### Server-side rate limiter

- **What:** a token-bucket limiter in the public server, keyed per client IP on `/v1/auth/*` and `/u/*`, and per
  player token on `/v1/events` and `/v1/commands`, answering 429 with the existing `ApiError.retryAfterMs`.
- **Why:** the closed beta leans on its allowlist (`ALLOWED_LOGINS`, the beta list, the admins) and one Cloudflare
  rate rule on `api.pathof.dev/v1/auth/*`. With open signup anyone can create a player and flood writes or profile
  renders, and one Cloudflare rule can't tell players apart.
- **Context:** keep the decision pure: `take(rule, bucket, now) => { allowed, bucket, retryAfterMs }` plus
  `prune(buckets, now, rule)`, held in a `Ref` and wrapped by a `RateLimiter.check(key, rule)` service. The client IP
  comes from a pure `clientIpOf(trust, headers, remote)`: trust `CF-Connecting-IP` only when the peer is in
  Cloudflare's published ranges (configure Traefik's `trustedIPs` to match), otherwise use the socket address. Never
  take the leftmost `X-Forwarded-For` entry, which the client controls. Properties: the number allowed in any window is
  at most capacity plus refill × window; a forged header from an untrusted peer never changes the key.
- **Depends on:** the public server entry (PR 5). Profile pages send `no-store` and render a snapshot per view with
  no cache (PR 6, decision 12A), so `/u/*` per client IP matters as soon as they are linked anywhere.

### Protect volume badges against faked counts

- **What:** stop a player unlocking the volume badges (100 commits, 50 merged PRs, 500 graded prompts) by posting
  made-up events: count them from verified work once the verifier exists, or bound them with the per-player event
  rate cap that open signup adds.
- **Why:** badges show on public profiles. `grant` counts `progress.totals` even past the daily XP cap
  (engine/src/step.ts, `grant`), and the private form's subject key is made by the mod, so a script can post 100
  distinct `commit.made` events in a minute. XP is bounded by the caps; the badges are not.
- **Context:** accepted for the closed beta, where the allowlist bounds who can do it (docs/plans/achievements.md,
  decision A1A). Options: a badge metric over verified facts only, a per-day cap on how much a total can grow toward
  a badge, or relying on the events-per-minute cap from "Open signup".
- **Depends on:** achievements (PR 7a); before open signup.

### Open signup

- **What:** drop the allowlist check (`Allowlist.allows`: `ALLOWED_LOGINS`, the `beta_logins` table and the admins)
  from sign-in and from `BearerAuth`, and add a per-player cap on events per minute. Keep `ADMIN_GITHUB_IDS` for what
  admins do next.
- **Why:** to let anyone play once abuse and growth are bounded.
- **Context:** the allowlist is checked in two places on purpose (sign-in and every request), so removing someone locks
  them out at once. Opening up removes both checks. Publish the privacy note (what's stored, export, delete, the game
  token at rest in the mod's `$.store`) before opening.
- **Depends on:** the server-side rate limiter; export and delete (PR 6).

## Known gaps from the review

### Dev commands out of the public build

- **What:** leave the dev commands out of what the public server decodes and runs: a command schema without them for
  its route, or the engine's dev handling in a module only the local server loads.
- **Why:** an online server can't be in dev mode (`devModeOf`, in server/services.ts), so the engine refuses every dev
  command there, but the commands still decode and the code that runs them still ships. A bug in that one check would
  let a player grant themselves XP, gold or items.
- **Context:** `Command` (schema/commands.ts) holds the dev commands, and `step` runs them when its context says `dev`.
  public.test.ts has a property that the public server refuses every dev command and its save stays as it was.
- **Depends on:** nothing; worth it before open signup.

### Change a session and log its event in one transaction

- **What:** in `presence.ts`, opening, closing and lapsing a session should change the `sessions` row and log its
  `session.*` event in one transaction, with the version guard inside it.
- **Why:** today `writer.guard` runs first, then the `sessions` change commits, then `apply` logs the event. If a newer
  build writes the player in between (a deploy rolling out), the event fails with `ServerBehind` after the row has
  committed: a new session is kept but `session.opened` is never logged, and the mod's retry finds it already heard.
- **Context:** wrapping both in one outer transaction nests `apply`'s, so `StreamHub.notify` would fire before the real
  commit and wake waiters early. Notify has to move after the outer commit. Found in the review of PR #32; a single
  replica makes the window small.

### Re-check logins against GitHub

- **What:** stop `pathof.dev/u/<login>` showing a former holder of a login after a GitHub rename, or after GitHub
  hands a freed login to someone else.
- **Why:** a player's row keeps the login it last signed in with until another account signs in under it
  (`findOrCreate` clears it then). Meanwhile the old holder's page answers for the login (PR 6, decision 3A).
- **Context:** nothing private leaks: only what the old holder made public, under a name they no longer hold. The
  options are a periodic `GET /user/{id}` for public players, which takes one GitHub call per public player, or showing
  a page only for a sign-in within some recent window.
- **Depends on:** open signup.

## Later features

### XP history on profiles

- **What:** a per-day XP chart on the profile page, as a hideable `history` section that starts hidden
  (`defaultShown: false` in `schema/profile.ts`).
- **Why:** v1 profiles show only where a player stands, not how they got there.
- **Context:** the partial index `server_events_progress` (migration 0012) serves the query, and
  `xp.granted.totalAfter` gives each local day's last total. Carried XP (migration 0009) writes no server event, and a
  prestige lowers the total, so the series must not claim to equal the state's XP.
- **Depends on:** profiles in use (PR 6b).

### Review badges

- **What:** add "first review" and "25 reviews" to the starter achievements, on reviews counted.
- **Why:** the user approved them for the starter list (2026-10-18), but nothing counts reviews today, so they would
  sit locked forever.
- **Context:** `review.acted_on` is verified-tier, and `grant` returns before it counts `progress.totals` for a
  verified fact (engine/src/step.ts, `grant`); `fact.verified` does nothing yet, the engine ignores
  `review.submitted`, and the mod never sends it. A schema filter refuses a badge on a verified-tier fact, so this
  needs either the verifier crediting reviews or a reported counter of `review.submitted` (the mod would have to send
  it). Plan: docs/plans/achievements.md.
- **Depends on:** "Named public subjects and the verifier", or a decision to count reported reviews.

### Prestige badge

- **What:** add "first prestige" to the starter achievements, on `progress.prestige` ≥ 1.
- **Why:** approved for the starter list, but no one can prestige yet.
- **Context:** `character.prestige` is in the command schema, but `applyCommand` refuses it as not available
  (engine/src/step.ts). The `Metric` union needs a `prestige` member, and the threshold property over the starter
  list will check the badge is earnable once prestige works.
- **Depends on:** implementing prestige.

### Badges tab in the pane

- **What:** a Badges tab in the mod's pane: earned badges, and locked ones with what earns them and their progress,
  with click-to-showcase once PR 7c's showcase slot exists.
- **Why:** after 7a the mod only celebrates an unlock; a player can't see their badges or what's next without the
  profile page, and picking showcase badges by typing ids is clumsy.
- **Context:** PR 7b puts locked progress (`badgeProgress`, gauges per locked def) in the snapshot, and the rules
  carry the definitions, so the pane needs no new server work. Follow `missionsViewOf(snapshot, rules)` and the
  wardrobe tab's layout (packages/mod/hooks).
- **Depends on:** PR 7b (progress in the snapshot); PR 7c for click-to-showcase.

### Cache profile pages at Cloudflare, with purge

- **What:** a Cloudflare cache rule on `pathof.dev/u/*` with `s-maxage=60`, plus an API purge of
  `pathof.dev/u/<login>` after a privacy change or a delete commits.
- **Why:** v1 sends `Cache-Control: no-store` (PR 6), so a hide or a delete takes effect at once, but every view
  renders. That is fine for a closed beta, not for real traffic.
- **Context:** needs a Cloudflare API token scoped to cache purge on the pathof.dev zone, as a server secret. Ship the
  rule and the purge together, never the rule alone: a cache without purge shows a hidden section or a deleted account
  for up to a minute. A failed purge only logs, as the TTL still bounds staleness.
- **Depends on:** open signup.

### Link a local save to an online account

- **What:** import a local save into the player's online account.
- **Why:** the design doc (2026-10-12) says players can link their local save when accounts arrive. v1 starts every
  online character fresh, since the only player today is the developer.
- **Context:** what carries over is still an open question in the design doc. Local logs name repos, so an import has
  to rewrite every subject into the private form, and an editable local save needs an anti-cheat policy (carry it over
  as reported XP only?). Entries marked `dev` are already labelled so an import can drop them.
- **Depends on:** a decision on what carries over.

### Postgres-backed stream hub

- **What:** a `StreamHub` implementation over Postgres `pg_notify`, sent after commit, so stream wakeups reach every
  instance.
- **Why:** v1 runs a single replica, and `StreamHub` is in-process. A second instance would see other instances'
  writes only when a long-poll times out (at most 25 seconds), never instantly.
- **Context:** keep the `StreamHub` interface, so the Postgres hub drops in without touching handlers. `server_events`
  stays the source of truth; a missed notify only delays. Pin Coolify to 1 replica until then.
- **Depends on:** needing a second instance.

### Named public subjects and the verifier

- **What:** send the named form (`type: "github"`) for repos confirmed public through the GitHub API, and build the
  verifier that resolves claims into verified XP.
- **Why:** in v1 the online server always gets the private form, so nothing is verifiable and nothing can rank.
  Leaderboards need verified XP.
- **Context:** the design doc's verification section describes a polling worker with ETags and claims that expire
  after 30 days. `ClaimDraft` and claims are stubbed in the engine and the writer. The mod's `repoOf` names any
  github.com remote today. The online target overrides that through `subjectFormOf`.
- **Depends on:** the public server; a GitHub App installation token for the API.

### Species sprites, with the mod drawing pixels from the server

- **What:** pixel art for the starter species and their evolution forms, served as data so the website and the mod
  draw the same pixels.
- **Why:** v1 draws the landing page's single 14x12 sprite for every pet. The design doc wants "the pet looks
  identical everywhere", and the mod hard-codes no art.
- **Context:** `schema/sprites.ts` is the source (site copy checked by `site.test.ts`). The mod imports only types from
  schema, so it has to receive pixel data in the snapshot or catalogue rather than importing it. Art is an open
  question in the design doc (commissioned or generated).
- **Depends on:** the art decision.

### Open Graph cards and a sitemap for profiles

- **What:** per-profile Open Graph images and tags, and a sitemap of public profiles.
- **Why:** shared profile links render as bare URLs today.
- **Context:** profiles are server-rendered HTML from `profilePage`, so the tags go in that template. A card image can
  reuse `spriteSvg`.
- **Depends on:** profiles in use.

### Token expiry and a devices list

- **What:** expire game tokens after a period without use, and list a player's signed-in devices so they can revoke
  one.
- **Why:** v1 tokens never expire, and logout revokes only the current device's token.
- **Context:** v1's `api_tokens` has `(token_hash, player_id, created_at)` only, with no `last_used_at`, so nothing is
  written per request. Add `last_used_at` (written at most hourly) and a label when this lands.
- **Depends on:** the accounts work (PR 4).
