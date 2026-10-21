# Plan: the companion, `pathofdev watch` (2026-10-21)

Planned against main at 7e74247 (#52). Source: the player's idea and the direction agreed with them, refined here.
File references are as of that commit.

## Goal
Give players who want more room a second window on the game: a terminal app run in a split pane or a second tab,
beside Claude Code, that draws a big pet, the missions, the loot, the Last prompt card and its history. It is fed by
the stream the server already sends the mod, and it shows the private bits (Haiku's note, the misspelled words) only
on the player's machine, never through a server.

Claude Code stays untouched. The band, the status line and the pane stay the default.

## Non-goals
- **A wrapper that hosts `claude` in a pty.** Rejected: it means writing a terminal emulator, it breaks easily, and
  players would have to launch Claude Code through our binary.
- **Actions in v1.** The watcher only reads: no buying, equipping, accepting or petting. Commands stay in Claude Code.
- **The map.** The game keeps no map yet (only opaque explored keys), so there is nothing to draw. It needs its own
  design first.
- **A web view.** It comes later, fed by the watcher's state (see "Later").
- **Windows.** v1 runs on macOS and Linux, which is where the local server and its Unix socket run today.
- **Changing the band** when the watcher runs. The player can already pick `band: line` (Open question 6).

## Facts found in the code (they drive the design)
- **The stream exists, and it is enough.** `GET /v1/stream?after=<cursor>&session=<id>` (`schema/src/http-api.ts`,
  `server/src/http.ts` `stream`) is a held long-poll. It answers at once with the events after `after`, or after 25 s
  with none. `StreamHub` wakes it on each commit. `players.ts` `streamAfter` answers `resync: true` when the cursor
  is ahead or more than `maxBehind` (1000) behind.
- **`session` is optional on the stream, and it is the presence heartbeat.** A watcher must never send it. If it
  did, a watcher would keep a session "live" and count toward the parallel missions (Two Minds, Juggler, Conductor).
- **The snapshot comes only from `POST /v1/sessions`.** It runs `refreshQuests` (which rolls a new day's missions,
  idempotently) and opens presence only when `presence: true`. Without it, no session opens. The mod reads the
  snapshot again after every batch of events (`register.tsx` `refresh`) rather than folding the events in.
- **The mod's drawing is pure.** `view.ts` (`viewOf`, `wardrobeOf`, `statsViewOf`), `missions.ts`, `stats.ts`,
  `card.ts`, `band.ts`, `frames.ts` and `pet-motion.ts` turn a snapshot and its events into `Row`s (`cells.ts`: runs of
  text with a colour, bold, dim and a background). Their imports are relative or type-only. Only `register.tsx` needs
  the host.
- **The mod's relative imports have no extension** (`'./cells'`). Node's type stripping resolves only full paths, so
  plain `node` can't load the mod's files as they are.
- **The plugin installs `packages/mod` alone** (`.claude-plugin/marketplace.json` `source: ./packages/mod`), with
  no `node_modules`. Online players have no clone. Local players run the server from one.
- **The mod can't listen on a socket.** It can `$.http.fetch` over one (`socketPath`, about 100 bytes at most), as it
  does to the local server. It can `$.fs.write` a file, but with no mode, and `$.fs.stat` shows neither mode nor owner.
- **The game token lives in the mod's `$.store`** (`token@<origin>`), inside Claude Code. No other process can
  read it.
- **What the stream carries for a graded prompt:** `xp.granted` with `reason`, `grade` and `amount`. The per-measure
  scores, `kind` and `spelledClean` live in `event_log`, which is never streamed. The note and the misspelled words never
  leave the mod (`docs/privacy.md`).
- **The pet's pixels** are `schema/src/sprites.ts` `petSprite`, 14×12. The band draws a text face for now.
- **The local server makes `~/.pathofdev` 0700** (`local.ts`, `mkdirSync` then `chmodSync`).

## Decisions (*plan*, for the player to confirm in Open questions)
1. **The watcher ships inside the plugin**, in `packages/mod/watch/`, so every player who installed the mod already
   has it. Its version is always the mod's, so the two sides of the local channel always match.
2. **No runtime dependencies.** It uses only `node:` built-ins and the mod's own pure files, the way the mod imports
   nothing at runtime. `effect` stays a devDependency, for the properties.
3. **A raw ANSI renderer** over the band's `Row`s (see "The TUI stack").
4. **Game state comes from the server's stream**, read straight from the server: the snapshot by `POST /v1/sessions`
   without `presence`, then `GET /v1/stream` without `session`. There is no new route in v1. PR 4 adds a read-only
   snapshot route (Open question 4).
5. **Private bits come from the mod, over a local socket the watcher listens on.** They stay in the watcher's memory
   only: never on disk, never to a server.
6. **The online token is handed over on the same socket** and kept only in memory. There is no second sign-in and
   no token file.

## Architecture
```
             Claude Code                                    split pane / second tab
  ┌──────────────────────────────┐                       ┌──────────────────────────────┐
  │ mod (band, status line, pane) │── POST /v1/watch ───▶│ watcher (node watch/main.ts)  │
  │  unchanged, plus one push     │   over watch.sock     │  memory only: note, misspelled│
  └──────────────┬───────────────┘   (0600, in a 0700    │  words, token                 │
                 │                    home)               └──────┬───────────────────────┘
                 │ events, commands, stream(session=…)          │ POST /v1/sessions (no presence)
                 ▼                                              ▼ GET /v1/stream (no session)
       local server over server.sock  ─or─  https://api.pathof.dev + Bearer
```
**Processes.** Three, as before plus one: Claude Code with the mod, the server (local or online), and the watcher.
The watcher is optional. When none runs, the mod's push is skipped after a single `$.fs.exists`.

**The watcher's loop** (`watch/stream.ts`, a pure state machine `next(state, answer)` and a thin driver):
```
start ─▶ home checked ─▶ watch.sock bound ─▶ target: --server flag, else the newest hello's, else local
  local  ─▶ server.sock (socketPathsOf), no token
  online ─▶ waits for a hello that carries a token ─▶ https origin + Bearer
snapshot (POST /v1/sessions, a fresh ULID, no presence) ─▶ cursor = snapshot.cursor
  ─▶ backfill: GET /v1/stream?after=max(0, cursor − 200), once, for Today's feed and the grade history
loop: GET /v1/stream?after=cursor
  events ─────────────────────▶ feed + history; snapshot again (as the mod does); cursor = answer.cursor
  resync / rulesVersion newer ─▶ snapshot again, cursor from it
  401 ────────────────────────▶ token dropped, "signed out": waits for the next hello
  429 / 5xx / no answer ──────▶ offline; retry after 5 s, doubling to 30 s, with jitter; reset on an answer
  minClientVersion > ours ────▶ "update the mod", and polling stops
```
It reuses `server.ts` from the mod: `socketPathsOf`, `originOf`, `failureOf`, `isStream`, `isSession`, and
`headersOf`'s rule that a token rides only https to its own origin. Local requests go through `node:http` with
`socketPath`. Online requests use the global `fetch`.

**The cost online:** one more held poll per player who runs the watcher, which is at most one request every 25 s
when idle, plus one snapshot per batch. The in-process `StreamHub` serves it on the single replica.

**The local channel: `POST /v1/watch` over `watch.sock`.** It is one message, last write wins per session. The mod
sends it when:
- a session starts;
- after each stream answer, including an empty one after 25 s, so a watcher started mid-session hears within 25 s;
- after a graded prompt;
- on a login, a logout or a server switch.

```
{ v: 1, clientVersion, sessionId, serverId, target: "local" | "dev" | "online",
  origin?: https origin,           online only
  token?: string | null,           online only; null after a logout
  scored?: ScoredPrompt,           the Last prompt card's input, as in the session's state
  note?: string,                   Haiku's note, from the coach memory
  misspelled?: string[] }          from the mod's memory only, as the card shows them
```
- **The watcher answers** 204 (taken), 400 (a body that doesn't decode, or over 64 KiB) or 409 (another `serverId`
  than the one it watches: shown as "another session plays on dev").
- **Delivery is best effort.** Each send has a short timeout, and a failure is dropped silently: no queue, no
  retry, no toast.
- **The mod sends nothing** when the socket isn't there.

**Where the socket lives:** `$PATHOFDEV_HOME/watch.sock`, else `~/.pathofdev/watch.sock`. The dev sandbox has its own
in `~/.pathofdev-dev`. The watcher, not the mod, makes the home: `mkdir` 0700, then `chmod` 0700 as `local.ts` does.
It refuses a home that isn't a directory, is a symlink, is owned by another user, or that others can write to. It
binds with `umask 0o177`, so the socket is 0600. A second watcher finds the socket answering, says "already watching
in another pane" and exits. A stale socket (nobody answers) is removed and bound again. The path's length is checked
as `local.ts` checks the server's.

**Package.** `packages/mod/watch/`, under the mod's `package.json`, with its own `tsconfig.json` that adds node's
types. `pnpm typecheck` covers it.
- **Loading the mod's files:** `watch/main.ts` first registers a resolve hook of about 20 lines
  (`module.registerHooks`), which tries `.ts` for an extensionless relative import. It then imports the rest, so the
  mod's files load unchanged.
- **Node version:** it needs Node 22.18 or newer (type stripping on by default, and `registerHooks`), and says so
  plainly on an older one.
- **The sprite:** `@pathofdev/schema` stays type-only. `watch/sprite.ts` copies `petSprite`, and a test holds it equal
  to the schema's, as `site.test.ts` does for the site.
- **Not needed:** the engine. The snapshot carries everything derived.

## The TUI stack
All three options were checked against the npm mirror the repo installs from: Ink 8.0.0, React 19.3.0 and
`@opentui/core` 0.5.16 are all on it, and current.

| | Ink 8 | OpenTUI 0.5 | Raw ANSI over the band's `Row`s |
|---|---|---|---|
| Runtime | Node ≥ 22 | Bun ≥ 1.3, or Node ≥ 26.4 | Node ≥ 22.18 |
| Dependencies | ink's 23, plus react 19.3, react-reconciler and yoga-layout (wasm) | a native binary per platform, plus 5; pre-1.0 | none |
| Fits the plugin install (no `node_modules`) | no: needs an install step or a bundler | no | yes |
| Band code reused | all the `Row` builders, each run as a `<Text>`; Ink's flex layout goes unused, since rows are laid out by cell | the same, into its buffer | all the `Row` builders, straight to SGR; `cells.ts` is the layout |
| What we write | little: Ink diffs, reads keys and resizes | little, but it doesn't run on our Node | about 250 lines: alt screen, line diff, SGR, keys, SIGWINCH |
| Risk | React in a long-running watcher; `string-width` and `cells.ts` `isWide` can disagree on a glyph, which shifts columns | runtime mismatch, native binaries, API churn | we own the terminal's edge cases: colour depth, wide glyphs |

**Recommendation: raw ANSI.** The band already lays out every row by cell, so a layout engine buys nothing. Only it
runs from the plugin install with no extra step. It needs no dependency, and it measures glyphs with the same
`cells.ts` the band uses, so the two never disagree.
- **`watch/screen.ts`:** `Row` → SGR (truecolor; 256 colours when `COLORTERM` doesn't say `truecolor`; the mod's theme
  names such as `claude` mapped to fixed hexes), clipped to the width by `cells.ts`.
- **`watch/term.ts`:** the alt screen and a hidden cursor, restored on exit, `SIGINT`, `SIGTERM` and a crash. A
  redraw writes only the lines that changed. `SIGWINCH` redraws. Raw stdin reads the keys.

Ink stays the fallback if a later version grows forms.

## What v1 shows
Four tabs: Home, Missions, Loot and Stats. `1`–`4` or `←`/`→` switch tabs, `q` quits and `?` shows the keys. The
watcher redraws on each answer and each minute, for the timers. It needs at least 40×16, and below that it says
"make this pane bigger". The pet is drawn from `petSprite` in half blocks at 2× (28×12) when there is room, and at 1×
(14×6) otherwise, in the sprite's own colours. The mockups below show it in plain characters.

**Home**
```
 ✦ PATH OF DEV ✦  Mira · Lv 7 Tinkerer · 412 gold                 local · live
 1 Home  2 Missions  3 Loot  4 Stats
 ─────────────────────────────────────────────────────────────────────────────
     ██                ██        Pixel · form 2 · happy ♥♥♥♥♡
   ██▓▓██            ██▓▓██
   ██▓▓▓▓██        ██▓▓▓▓██      XP ████████████░░░░░░  3,155 / 4,570
   ██▓▓▓▓▓▓████████▓▓▓▓▓▓██      Streak 5 days · 2 rest days left
 ██▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓██    Sigil ×1.2 worn
 ██▓▓▓▓  ▝▘▓▓▓▓▓▓▓▓  ▝▘▓▓▓▓██
 ██▓▓▓▓    ▓▓▓▓▓▓▓▓    ▓▓▓▓██    Running: Clear Thinker 3/5 · ends 23:59
 ██▓▓▒▒▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▒▒▓▓██
 ██▓▓▓▓▓▓▓▓░░░░░░░░▓▓▓▓▓▓▓▓██
   ██▓▓▓▓▓▓░░░░░░░░▓▓▓▓▓▓██
     ██▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓██
       ████        ████
 Last prompt · 8.2 · +12 XP · task                                   2 sessions
 intent 9  grounding 8  why –  success –  scope 9  forward 8  – didn't apply
 base 7.6 · craft +0.3 · spelling +0.2 · tone +0.1
 “Say which test should pass when it's done.”
 Today
 14:02  +12 XP   prompt 8.2
 13:55  ◆ rare   Sigil of Focus dropped
 13:40  ▲        Clear Thinker 3/5
```
The card is `card.ts` `cardRows`, at the pane's width. The card and its note show only once a mod has pushed them.
Without that, the line reads `Last prompt · 8.2 · +12 XP`, taken from the stream's `xp.granted`. A celebration
(level-up, epic or legendary loot, a mission done) plays `frames.ts`'s frames across the top rows, at the size the
pane allows, as the band would with `animations: full`.

**Missions** (`missions.ts`, as the pane's tab, wider)
```
 Daily · resets in 9h 12m                                   picks 1 of 3 left
 ▸ Clear Thinker   Write 5 prompts that make clear what you want    ███░░ 3/5
   Pinpoint        Write 3 prompts that point at exactly what …     ░░░ 0/3
 Weekly · resets Mon
 ▸ Wordsmith's Week  Get 25 prompts graded very well this week      ████░░░░ 11/25
```

**Loot** (`view.ts` `wardrobeOf`, `pane.ts` `lookSections` and `otherItems`)
```
 Worn                        Bag (14)
 head   Plain Cap   common   ◆ Sigil of Focus     rare      ×1.2
 frame  Ember Edge  epic     ◇ Rusty Gear         common
 sigil  Focus ×1.2  rare     ◇ Shard ×3           uncommon
 Recent drops: 13:55 Sigil of Focus (rare) · yesterday Ember Edge (epic)
```

**Stats** (`stats.ts` `statsViewOf`, plus the history)
```
 Prompts graded 212 · average 7.4 · best 9.3        (rubric 2 since Oct 20)
 intent 7.9  grounding 7.1  why 6.4  success 6.0  scope 8.2  forward 7.3
 Last 30 grades  ▅▆▄▇▆▅▆▇█▆▅▄▆▇▆▅▆▇▆▅▄▆▇▆▅▆▇▆▇▆   (from the stream)
 This run's prompts (your machine only)
 14:02  8.2  task        “Say which test should pass when it's done.”
 13:31  6.9  discussion  “Name the two options you're weighing.”   spelled: "recieve"
```
The grade history comes from the stream's `xp.granted` (the backfill and what follows), so it survives a restart.
"This run's prompts" holds what the mod pushed since the watcher started: measures, note and misspelled words, in
memory only, the last 50. A restart forgets them, as a reload of the mod forgets the misspelled words.

**Not in v1:** the shop, pet care, the welcome, the badges grid (Stats shows the count), leaderboards, profiles, the
map, actions and sound.

## Installing and starting it
- **From Claude Code:** `/pathofdev watch` answers with the exact command for this install, such as
  `node ~/.claude/plugins/cache/…/pathofdev/0.8.0/watch/main.ts`, worked out from `$.plugin.root`. It also offers
  `/pathofdev watch open`.
- **`/pathofdev watch open`** opens a split itself, through `$.process.run`, when the terminal can:
  `tmux split-window -h` under `$TMUX`, `zellij run -d right --` under `$ZELLIJ`, `wezterm cli split-pane --right --`
  under `$WEZTERM_PANE`, and `kitty @ launch --location=vsplit` when kitty's remote control is on. Ghostty has no
  command for a split, so there, and anywhere else, it says to open a split or a tab and paste the command.
- **From a clone:** `pnpm --filter @pathofdev/mod watch`.
- **Flags:** `--server local|dev|online` pins the target, which the newest hello's target picks otherwise.
- **After a plugin update,** the old path still runs the old watcher. The hello carries `clientVersion`, so the
  watcher says "the mod updated: restart watch". `/pathofdev watch` always prints the current path.
- **How players learn of it:**
  - a line in the pane's footer ("More room? /pathofdev watch");
  - one sentence in the welcome's last step;
  - a README section;
  - the `band` option's description.
  - No toast: it would be noise for players who don't want it.

## Privacy and security
- **Nothing new reaches a server.** The watcher sends only `POST /v1/sessions` (a ULID, no presence) and
  `GET /v1/stream`. Each carries nothing but the cursor and the client header.
- **The private bits** (the note, the misspelled words) travel from the mod to the watcher over `watch.sock` alone.
  Neither side writes them to disk, logs them or sends them to any server. This keeps `docs/privacy.md`'s promise,
  which today says the note and the words stay "in the mod's memory on your machine". PR 2 widens that to "the mod's
  memory, and the watcher's while it runs, on your machine". The misspelled words still never enter the session's
  state, which other plugins can read.
- **The prompt's text** is never pushed. The card doesn't need it.
- **Who can reach the socket:** only the player's own user, as for `server.sock`. The socket is 0600, in a home that
  is 0700 and owned by the player, and the watcher checks both. The mod can't check modes, but it sends only to
  `watch.sock` in the home it already trusts for `server.sock`. Anything that runs as the same user could bind it
  first, but such a process can already read Claude Code's transcripts and store, so the socket exposes nothing new.
- **The token** sits on no disk of ours: the mod hands it over in each hello while online, and the watcher keeps it
  in memory. It rides only https to the origin it came with (`headersOf`'s rule, checked by the same property). It
  never goes to `server.sock` or `watch.sock` in a request the watcher makes. It is never logged. A logout sends
  `token: null`, and a 401 drops it.
- **Least privilege:** the watcher holds the full game token but only ever sends GETs and the session read.
  A read-only token scope would be tighter, but it touches `auth/*` (Open question 3).
- **The terminal:** every string from the server or a push is stripped of control characters before it is drawn
  (the C0 and C1 ranges, ESC included), so neither can inject escape sequences into the pane. A property checks it.

## Failure modes
| What happens | What the watcher shows or does |
|---|---|
| No watcher running | The mod's `$.fs.exists` is false, so nothing is sent and nothing is noticed |
| A stale `watch.sock` after a crash | The mod's send fails fast and is dropped. The next watcher removes the socket and binds again |
| A second watcher | "Already watching in another pane", then it exits 0 |
| The local server is down | "local · offline, start it with pnpm --filter @pathofdev/server start", retried as above |
| Online, with no hello yet | "Waiting for Claude Code to hand over your sign-in: start a session, or run /pathofdev watch" |
| 401 (logged out, off the beta, account deleted) | "Signed out: /pathofdev login in Claude Code"; it waits for a hello with a new token |
| 503 `ServerBehind`, a deploy, the network gone | "offline", with backoff to 30 s; it catches up from the cursor on return |
| `resync` (a reset, the cursor too far behind) | A new snapshot; the feed keeps its lines and marks the gap |
| Sessions on two targets | It follows the newest hello's target unless `--server` pins one; the header names it |
| The plugin updated under it | "The mod updated: restart watch" |
| Node missing or older than 22.18 | `/pathofdev watch` runs `node --version` first, and both it and `main.ts` say what is needed |
| A tiny pane, no truecolor, a narrow font | "Make this pane bigger"; 256 colours; widths from `cells.ts` |
| A malformed or oversized push | 400, ignored; the decoders are total |
| A crash | The terminal is restored (alt screen off, cursor shown) before it exits non-zero |

## Tests
Properties (fast-check through `effect`, in `packages/mod/test/watch-*.prop.ts`, as the mod's are):
- **Screen:**
  - For any rows and width, each line drawn is at most `width` cells by `cells.ts`.
  - Stripped of SGR, it is the rows' text clipped.
  - Every line ends reset.
  - Applying a redraw's line diff to the previous screen gives the new one.
- **Stream machine:**
  - The cursor never goes back except on `resync`.
  - `resync` and a newer `rulesVersion` always lead to a snapshot.
  - After a 401, no request goes online until a hello brings a token.
  - Backoff stays within 5–30 s, grows until an answer, and resets on one.
  - A stream request never carries `session`, and a snapshot request never carries `presence`.
- **Channel:**
  - The decoders are total on arbitrary JSON.
  - Bodies over 64 KiB are refused.
  - A push for another `serverId` is answered 409 and changes nothing.
- **Privacy canaries:** a canary in `note`, `misspelled` or `scored` never appears in any request the watcher makes,
  in any file under the home, or in its stderr.
- **The token** reaches only its https origin, and never a socket.
- **The sprite** copy equals `schema`'s `petSprite`.

Glue, with examples:
- the watcher against the real local server in a temp home (the server's test fixtures): a snapshot, an event arriving
  on the stream, a `resync`, and the server stopped and started again;
- against `fakeServer` online, with a token handoff, a 401 and a logout;
- the mod in `pathofdev.test.ts`, against a fake `watch.sock`: a graded prompt pushes the card, the note and the
  words; with no socket, no request is made; a logout pushes `token: null`;
- the home checks: 0700 made, a group-writable or foreign home refused, the socket 0600, a second instance exits, a
  stale socket is replaced;
- the terminal restored after a thrown error (a pty-free test on the `term.ts` writer).

Manual, recorded in each PR: a tmux split and a second tab on macOS, local and online.

## PR breakdown (in order)
1. **PR 1: the watcher, local, Home.**
   - `packages/mod/watch/`: `main.ts` (the resolve hook, the Node check, flags), `term.ts`, `screen.ts`, `stream.ts`,
     `home.ts`, `sprite.ts`;
   - the home and socket checks, with the socket bound and answering 204 to nothing yet;
   - the local target only;
   - the Home tab without the card;
   - the `watch` script, the screen, stream and sprite properties, and glue against the local server.
   - It touches no server file and no mod hook.
2. **PR 2: the channel and the card.**
   - The mod's push (`register.tsx`: session start, each stream answer, a graded prompt, login, logout and switch;
     `server.ts` gets `watchSocketOf`);
   - the watcher's `POST /v1/watch`, the token handoff and the online target;
   - the Last prompt card and "This run's prompts";
   - the `docs/privacy.md` wording;
   - the canary and token properties; `plugin.json` bumped.
   - It touches no server file. *Tell the online session:* a new client now polls `/v1/sessions` and `/v1/stream`
     without presence, and `privacy.md` changed.
3. **PR 3: the other tabs and discovery.**
   - Missions, Loot and Stats with the history;
   - the celebration frames;
   - `/pathofdev watch` and `watch open`;
   - the pane footer, the welcome line, the README, the `band` option's description;
   - `plugin.json` bumped.
   - It touches no server file.
4. **PR 4 (server; the online session's files): a read-only snapshot.**
   - `GET /v1/snapshot` → `{ snapshot, rules, minClientVersion }`, with no `refreshQuests` and no presence;
   - `schema/src/http-api.ts` and `server/src/http.ts`, with tests in `server/test/http.test.ts`;
   - the watcher switches to it when it answers, and keeps `POST /v1/sessions` on a 404 from an older server.
   - It can land any time after PR 1, and is deployed online by the online session.

The online session must be told about PR 4, which edits `http.ts`, and must read PR 2's `privacy.md` change. No PR
touches `public.ts`, `auth/*`, `players.ts`, `profile*`, `pages.ts` or `migrations.ts`.

## Later
- **A web view:** the watcher serves a page on `127.0.0.1` with a one-time token in the URL, from the same state, so
  the private bits still never leave the machine.
- **Actions** through `POST /v1/commands`: equip, accept, buy.
- **The map,** once the game has one.
- **A read-only token scope** (Open question 3).
- **An npm package** (`npx pathofdev watch`) for players who want it outside the plugin.

## Open questions (for the player)
1. **Where does it ship?** In the plugin (`packages/mod/watch/`), as a `packages/companion` published to npm as
   `pathofdev`, or only from a clone?
   - **Recommendation: in the plugin.** Every player already has it, online players included. Its version matches the
     mod's, so there is no install step and no publishing. The price is no runtime dependencies, which the mod already
     lives with.
2. **Should the watcher show the private bits at all?**
   - **Recommendation: yes, over the socket, in memory only.** The card and its note are much of why players want the
     watcher. The socket is no wider than what the same user can already read. The alternative is a watcher that shows
     only what the server streams: grades and XP, no measures, no note.
3. **How does it sign in online?** By the mod's token handed over in memory, by its own device-flow sign-in with a 0600
   token file, or by a read-only watch token the server mints (in `auth/*`)?
   - **Recommendation: the handoff for v1.** It needs no second sign-in, no token on disk and no server change. A
     read-only scope later, with the online session, if the watcher ever runs where the mod doesn't.
4. **Should PR 4 (`GET /v1/snapshot`) be in v1?** Today the watcher's snapshot calls `refreshQuests`, a write that is
   idempotent and that a mod would make anyway.
   - **Recommendation: yes, right after PR 1.** It is small, it makes the watcher read-only for real, and the fallback
     keeps older servers working.
5. **Should `/pathofdev watch` open a split by itself?**
   - **Recommendation: no.** It prints the command, and `watch open` opens a split only when the player asks, since
     it runs a command in their terminal.
6. **Should the band quiet down while a watcher runs** (stay shut in `auto`, and leave celebrations to the watcher)?
   - **Recommendation: not in v1.** The player picks `band: line`. Revisit once players have used both.
7. **Should more than one watcher run per home?**
   - **Recommendation: one in v1.** Several would mean one socket each, and the mod listing and pushing to each of
     them.
