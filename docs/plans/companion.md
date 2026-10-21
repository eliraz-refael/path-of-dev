# Plan: the companion, `pathofdev watch`, in Rust (2026-10-21)

Planned against main at 2a1581f (#58). It replaces the Node plan merged in #53: the player decided that the companion
is not a Node app ("TUI in node is terrible"), so it is a Rust binary. File references are as of that commit. The
target is the mockup at https://claude.ai/artifact/UZ2E3wLwtrkerpYaN4Umjo (example data) and the mockups below.

## Goal
Give players who want more room a second window on the game: a terminal app run in a split pane or a second tab,
beside Claude Code, that draws a big pet, the missions, the loot, the Last prompt card and its history. It is fed by
the stream the server already sends the mod, and it shows the private bits (Haiku's note, the misspelled words) only
on the player's machine, never through a server.

Claude Code stays untouched. The band, the status line and the pane stay the default.

## Non-goals
- **A wrapper that hosts `claude` in a pty.** Rejected: it means writing a terminal emulator, it breaks easily, and
  players would have to launch Claude Code through our binary.
- **Actions in v1.** The app only reads: no buying, equipping, accepting or petting. Commands stay in Claude Code.
- **The map.** The game keeps no map yet (only opaque explored keys), so there is nothing to draw.
- **A web view.** It comes later, fed by the app's state (see "Later").
- **Windows in v1** (Open question 2).
- **Changing the band** when the app runs. The player can already pick `band: line`.

## What stands from #53
The player answered #53's open questions "as recommended". Those that still apply carry over unchanged:
- **The private bits are shown**, sent over a local socket and kept in the app's memory only.
- **The online token is handed over by the mod** in memory, for v1. There is no second sign-in and no token file.
- **The read-only snapshot route is in v1.** It is now its own PR, in flight (see "Facts").
- **`/pathofdev watch open` opens a split only when asked.** `/pathofdev watch` itself only prints.
- **The band is not quieted** while the app runs.
- **One app per home.**

The first answer, "ship it inside the plugin", falls: the plugin has no build step, so a Rust binary can't ride in it
(see "Distribution").

## Facts found in the code (they drive the design)
- **The stream is a held JSON long-poll, not SSE.** `GET /v1/stream?after=<cursor>&session=<id>` answers one
  `StreamResponse` body (`schema/src/api.ts`) at once, or after 25 s with no events (`server/src/http.ts`
  `streamTimeout`, under the proxies' 30 s). There is no `text/event-stream` and no chunked feed. So the client is
  plain request and answer, with a read timeout a little over 25 s.
- **`session` on the stream is the presence heartbeat.** The app must never send it, or it would keep a session live
  and count toward the parallel missions.
- **The read-only snapshot is in flight** (branch `watch-snapshot`): `GET /v1/snapshot` →
  `SnapshotResponse { snapshot, rules, minClientVersion }` (`schema/src/api.ts`). It rolls no missions and opens no
  session. It answers 401, 429 (rate-limited as a request of no events, `limits.ts`) and 503 `ServerBehind`. Its PR
  pins a JSON fixture of the answer for tests in other languages.
- **Effect 4.0.0 makes JSON Schema with `Schema.toJsonSchemaDocument`** (draft 2020-12), not Effect 3's
  `JSONSchema.make`.
- **The mod's drawing is pure TypeScript** (`mod/hooks/`): `card.ts` (`cardRows`, `cardText`), `missions.ts`,
  `stats.ts`, `view.ts`, `frames.ts` (with its `looks` as plain data), over `cells.ts` (`cellsOf`, `isWide`). None of it
  runs in Rust. It is reimplemented, and held to the TypeScript by fixtures.
- **The plugin installs `packages/mod` alone** (`.claude-plugin/marketplace.json`), with no build step and no
  `node_modules`. Online players have no clone.
- **The mod can run commands** (`$.process.run`, as it runs `git` and `ssh -G`), so it can look for the binary.
- **The mod can't listen on a socket.** It can `$.http.fetch` over one (`socketPath`, about 100 bytes at most), as it
  does to the local server. So the app listens, and must speak HTTP/1.1 on a Unix socket.
- **The game token lives in the mod's `$.store`** (`token@<origin>`). No other process can read it.
- **What the stream carries for a graded prompt:** `xp.granted` with `reason`, `grade` and `amount`. The measures,
  `kind` and `spelledClean` are never streamed. The note and the misspelled words never leave the mod
  (`docs/privacy.md`). `ScoredPrompt`, the card's input, is a mod type (`mod/types`), not a schema one.
- **The pet's pixels** are `schema/src/sprites.ts` `petSprite`: 14×12 letters and a palette of six hexes.
  `engine/test/site.test.ts` already holds the site's copy equal to it.
- **Versions:** the mod's is `0.9.0` (`mod/hooks/server.ts` `clientVersion`, sent as `PathOfDev-Client`). The server
  reads that header only to tag a presence (`http.ts` `clientOf`). Its `minClientVersion` is `"0.0.0"` (`game.ts`),
  and it names the mod's version.
- **The local server makes `~/.pathofdev` 0700** (`local.ts`).
- **The repo has no Rust and no `flake.nix`.** `pnpm-workspace.yaml` lists only `packages/*`. The Dockerfile copies
  `.` and relies on `.dockerignore`. The `mod` CI job runs `claude plugin test packages/mod`, and vitest runs every
  `packages/*/test/**/*.test.ts` and the mod's `test/**/*.prop.ts`.

- **A spike, kept out of the repo, proved the toolchain here:** nixpkgs' cargo and rustc 1.99.0; crates download from
  crates.io; a ratatui 0.30.2 app reads `petSprite` (exported to JSON by Node from `sprites.ts`) and draws it in half
  blocks at 2× and 1×, with truecolor SGR (`38;2;42;31;74` is `#2a1f4a`), in an 80×24 tmux pane. `cargo fmt --check`
  and `cargo clippy -D warnings` pass; `nix build` of the same crate works.

## Decisions (*plan*, for the player to confirm in Open questions)
1. **A Rust binary, `pathofdev`, whose command is `pathofdev watch`**, in `crates/pathofdev/`, under a Cargo
   workspace at the repo root.
2. **ratatui 0.30 over crossterm 0.29**, the one ratatui re-exports.
3. **No async runtime.** Threads and channels from `std`, ureq 3 for the server (https and `server.sock`), and
   tiny_http 0.12 for `watch.sock`.
4. **Hand-written serde types, held to fixtures the TypeScript writes**, with a check that every field the fixtures
   carry is either read or listed as unread.
5. **Prebuilt binaries on GitHub Releases**, built by dist (cargo-dist) with a shell installer and a Homebrew tap,
   plus a nix flake package and `cargo install --git`. The mod prints the right command.
6. **The data flow is #53's:** the snapshot by `GET /v1/snapshot`, then `GET /v1/stream` without `session`, and the
   mod's push of the private bits and the token over `watch.sock`.

## Architecture
```
             Claude Code                                    split pane / second tab
  ┌──────────────────────────────┐                       ┌──────────────────────────────┐
  │ mod (band, status line, pane) │── POST /v1/watch ───▶│ pathofdev watch (Rust)        │
  │  unchanged, plus one push     │   over watch.sock     │  memory only: note, misspelled│
  └──────────────┬───────────────┘   (0600, in a 0700    │  words, token                 │
                 │                    home)               └──────┬───────────────────────┘
                 │ events, commands, stream(session=…)          │ GET /v1/snapshot
                 ▼                                              ▼ GET /v1/stream (no session)
       local server over server.sock  ─or─  https://api.pathof.dev + Bearer
```
**Threads.** Three, and no runtime:
```
ui thread       crossterm event::poll(250 ms) for keys and resizes; drains both channels; draws when the state
                changed, and each second for the timers
  ◀── mpsc ──   stream thread: snapshot, then GET /v1/stream?after=cursor in a loop (ureq, 35 s read timeout)
  ── mpsc ──▶   (the target and the token, when a hello changes them)
  ◀── mpsc ──   channel thread: tiny_http on watch.sock; each hello decoded and answered there
```
**The stream machine** (`stream.rs`, a pure `next(state, answer) -> (state, request)` and a thin driver):
```
start ─▶ home checked ─▶ watch.sock bound ─▶ target: --server flag, else the newest hello's, else local
  local  ─▶ server.sock (the mod's socketPathsOf rules), no token
  online ─▶ waits for a hello that carries a token ─▶ https origin + Bearer
GET /v1/snapshot ─▶ cursor = snapshot.cursor
  ─▶ backfill: GET /v1/stream?after=max(0, cursor − 200), once, for Today's feed and the grade history
loop: GET /v1/stream?after=cursor
  events ─────────────────────▶ feed + history; GET /v1/snapshot again (as the mod reads it again); cursor moves
  resync / rulesVersion newer ─▶ GET /v1/snapshot, cursor from it
  401 ────────────────────────▶ token dropped, "signed out": waits for the next hello
  429 ────────────────────────▶ waits the time it names, as the mod does
  5xx / no answer ────────────▶ offline; retry after 5 s, doubling to 30 s, with jitter; reset on an answer
  404 on /v1/snapshot ────────▶ "this server is older than pathofdev: update it"; polling stops
```
There is no `POST /v1/sessions` fallback, unlike #53: the public server ships the route before the app, and a local
server updates with `git pull`.

**The cost online:** one more held poll per player who runs the app, at most one request every 25 s when idle, plus
one snapshot per batch, inside the snapshot route's rate limit.

## Where it lives
```
Cargo.toml              [workspace] members = ["crates/*"], resolver 3, shared [workspace.lints], release profile
Cargo.lock              committed: it is a binary
rust-toolchain.toml     channel = "1.99", components rustfmt and clippy (read by rustup in CI; nix ignores it)
flake.nix, flake.lock   devShell (cargo, rustc, clippy, rustfmt, rust-analyzer, cargo-dist) and packages.pathofdev
dist-workspace.toml     dist's settings: targets, installers, the tap (PR 2)
crates/pathofdev/
  Cargo.toml            package pathofdev, bin pathofdev
  assets/               sprite.json, looks.json: written by the TypeScript, embedded with include_str!
  src/main.rs           flags (--server, --version, --help, by hand, no clap); a panic hook restores the terminal
  src/wire.rs           the serde types: snapshot, stream answer, hello
  src/client.rs         the ureq agent: https, and a Unix-socket connector for server.sock
  src/stream.rs         the stream machine and its thread
  src/channel.rs        the home and socket checks, tiny_http on watch.sock
  src/ui/               app.rs, home.rs, missions.rs, loot.rs, stats.rs, card.rs, sprite.rs, frames.rs
  tests/                contract.rs, parity.rs, screens/ (expected text of each tab)
contract/               the fixtures the TypeScript writes and the Rust reads (see "The contract")
```
- **Why a root workspace:** `cargo` works from the root as `pnpm` does, and dist expects the workspace at the root.
  `crates/` leaves room for a second crate (a web view) without a move.
- **The two stay apart:** pnpm sees only `packages/*`, Cargo only `crates/*`. `target/` goes in `.gitignore`.
  `.dockerignore` gains `crates`, `contract`, `target`, `Cargo.*`, `rust-toolchain.toml`, `flake.*` and
  `dist-workspace.toml`, so the server's image is the same bytes as before.
- **Assets inside the crate:** the files the binary embeds live in `crates/pathofdev/assets/`, not `contract/`,
  because a published crate can't reach outside its own directory (Open question 6).

**CI: a `rust` job in `ci.yml`**, beside `ci`, on `ubuntu-latest` and `macos-latest` (the socket and mode code is
platform code):
```yaml
  rust:
    strategy: { matrix: { os: [ubuntu-latest, macos-latest] } }
    runs-on: ${{ matrix.os }}
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v7
      - run: rustup show            # installs rust-toolchain.toml's toolchain
      - uses: Swatinem/rust-cache@v2
      - run: cargo fmt --all --check
      - run: cargo clippy --workspace --all-targets --locked -- -D warnings
      - run: cargo test --workspace --locked
      - run: cargo build --release --locked
```
It is made a required check once it is green on main. The `ci` job already runs the TypeScript half of the contract.

**The devShell: yes, add `flake.nix`.** The owner uses nix, never Homebrew, and the spike showed that the obvious
`nix shell nixpkgs#cargo nixpkgs#rustc` can't link on macOS (`ld: library not found for -liconv`), while a `mkShell`
devShell links fine, because its stdenv brings `libiconv`. The same flake gives `packages.pathofdev`
(`rustPlatform.buildRustPackage` over `Cargo.lock`), which the spike built and ran on aarch64-darwin. The devShell
holds only the Rust tools: Node and pnpm stay as they are set up today. A binary built in the devShell links
`libiconv` from `/nix/store`, so release binaries come only from CI's runners, never from a nix shell.

## The stack
Versions are as on crates.io on 2026-10-21, resolved by the spike. Crate counts are unique crates among normal
dependencies, by `cargo tree`.

| | ureq 3.4 and threads | tokio 1.54 and reqwest 0.13 |
|---|---|---|
| Crates | 27 for ureq | 104 for the two alone |
| TLS | rustls with ring | rustls with aws-lc-rs by default: a C build (`aws-lc-sys`) on every target |
| `server.sock` | a `Connector` over `UnixStream`, about 80 lines, after ureq's own `TcpConnector`. The trait is in ureq's `unversioned` module, so ureq is pinned `=3.4.2` | built in: `ClientBuilder::unix_socket` |
| The 25 s poll | a blocking GET with a 35 s read timeout, on its own thread | an async GET, on a runtime |
| The draw loop | `event::poll` and `try_recv` | crossterm's `EventStream` and `tokio::select!` |

**Recommendation: ureq and threads.** The app holds two connections and one poll at a time: a runtime buys nothing,
and it costs a C build and four times the crates. If the Unix connector proves fragile, reqwest's blocking client
(which has `unix_socket`) is the fallback, at reqwest's cost.

**The dependencies:**
- **ratatui 0.30.2,** with its default crossterm backend: `ratatui::crossterm` (0.29), never a second `crossterm` of
  our own, so the two can't disagree. It brings 68 crates.
- **serde 1.0.229** (derive) and **serde_json 1.0.154.**
- **ureq =3.4.2** with `json`, and its default rustls and webpki roots. `https_only` online.
- **tiny_http 0.12.0** with no TLS features, for `Server::http_unix` on `watch.sock`.
- **rustix 1.1** (`process`, `fs`), already in the tree under crossterm: `getuid` and `umask` for the home checks.
- **jiff 0.2.38**, for local times ("14:02", "resets in 9h 12m") from the system's time zone database.
- **Dev only:** serde_ignored 0.1.14 (the contract check) and proptest 1.12 (the properties).
- **Not taken:** clap (three flags), anyhow (one error enum), a `ulid` (the snapshot route needs no session id),
  `unicode-width` of our own (ratatui's is the one that measures).

ratatui, serde, ureq and tiny_http together resolve to about 100 crates. The spike's release binary, with ratatui and
serde alone, is 1.1 MB.

## The contract with the TypeScript schema
| | typify from JSON Schema | Hand-written serde, held to TypeScript fixtures |
|---|---|---|
| How | `Schema.toJsonSchemaDocument` per response, then typify (0.10.0-alpha.3) into Rust | serde types for the fields the app draws; TypeScript writes example answers; Rust decodes them |
| Drift caught | only when someone regenerates, which needs Node in the Rust build or a committed codegen step | on every CI run |
| What it covers | the whole `Snapshot` (`domain.ts` alone is 389 lines), most of which the app never reads | what the app reads, and a list of what it doesn't |
| Risks | a pre-1.0 alpha, on draft 2020-12 output with `$defs`, literal unions, brands and checks; noisy generated types | a field the app reads but no fixture carries; handled by building the fixtures from full values |

**Recommendation: hand-written serde types, held to fixtures written by the TypeScript, with an ignored-field
ledger.** JSON Schema can come later, if a second consumer appears.
- **The fixtures, in `contract/`.** Each is built in TypeScript from real code, encoded by its Effect Schema (so it is
  valid by construction), and written as pretty JSON:
  - `snapshot.json`: the snapshot PR's pinned answer. PR 1 reads it where that PR puts it, or moves it here with its
    test.
  - `stream.json` and `stream-resync.json`: answers carrying each event type the app draws.
  - `hello.json` and `hello-local.json`: the mod's push, made by the mod's own `helloOf` from a pinned input (PR 3).
  - `card/<case>.json` and `card/<case>-<width>.txt`: card inputs, and `cardRows` at 40, 60 and 80 columns as text,
    with each run's colour beside it (`.runs.json`).
  - `glyphs.json`: every glyph the card, the tabs and the frames use, with `cells.ts` `cellsOf` for each.
- **Who writes them:** `packages/server/test/contract.test.ts` (snapshot, stream) and
  `packages/mod/test/contract.prop.ts` (hello, card, glyphs, sprite and looks, the last two into
  `crates/pathofdev/assets/`). By default each test
  compares what it builds with the committed file and fails on a difference. With `PATHOFDEV_WRITE_CONTRACT=1` it
  writes instead. `pnpm contract` runs both that way.
- **The Rust side** (`tests/contract.rs`) decodes each fixture through `serde_ignored`, collecting the path of every
  field it skipped, with array indices folded to `[]`. That set must equal `contract/unread.txt`, the fields the app
  deliberately leaves alone.
  - A field renamed in TypeScript: a required field goes missing, and the old name shows up as unread. It fails.
  - A field added: it shows up as unread and fails, until the app reads it or `unread.txt` lists it.
  - A field removed: the decode fails if the app read it, and `unread.txt` has a stale line if not. It fails.
- **The drift check is two required jobs:** `ci` fails when the TypeScript changed and the fixtures weren't
  rewritten; `rust` fails when the fixtures changed and the Rust types didn't follow.
- **At run time the types are lenient:** no `deny_unknown_fields`, and unknown event types land in a
  `#[serde(other)]` variant that draws nothing, so a newer server still works. When a snapshot no longer decodes, the
  app says "this server is newer than pathofdev 0.1.0" and the upgrade command, rather than drawing half a state.

## Reusing the visuals
- **The sprite is exported, not copied.** The mod's contract test writes `petSprite` to
  `crates/pathofdev/assets/sprite.json`, so no Rust copy can drift. The binary embeds it with `include_str!` and a test
  decodes it. It draws in half blocks, as the spike did: each cell holds two pixels, the top one as the foreground of
  `▀` and the bottom one as its background, an empty top as `▄`, both empty as a space. That gives 28×12 cells at 2×
  and 14×6 at 1×, in truecolor.
- **The celebration looks** (`frames.ts` `looks`, `rarityColors`) are data too, exported to `assets/looks.json`. The
  frame layout itself is reimplemented.
- **The card, the tabs and the frames are reimplemented in ratatui.** Parity means the same input gives the same
  text:
  - **The card:** for each `contract/card/` case and width, the Rust widget drawn into a ratatui `Buffer` gives the
    TypeScript's lines, cell for cell (trailing spaces trimmed), and the same colour on each run.
  - **The frames:** the same, for each celebration at a few ticks and widths (PR 4).
  - **Widths:** for every glyph in `glyphs.json`, ratatui's `unicode-width` gives the same cells as `cells.ts`
    `isWide`. Where they differ, the app draws a stand-in and the test names the glyph.
  - **Missions, Loot and Stats** have no TypeScript twin at these sizes. They are drawn from the snapshot fixture and
    checked against expected text in `tests/screens/` (rewritten with `PATHOFDEV_WRITE_SCREENS=1`). Their words come
    from the snapshot (names, descriptions), so they say what the pane says.

## What v1 shows
Four tabs: Home, Missions, Loot and Stats. `1`–`4` or `←`/`→` switch tabs, `q` quits and `?` shows the keys. The
app redraws on each answer and each second for the timers. It needs at least 40×16, and below that it says "make
this pane bigger". The pet is drawn at 2× when there is room and 1× otherwise, in the sprite's own colours (256
colours when `COLORTERM` doesn't say `truecolor`). The mockups show it in plain characters.

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
The card is the card widget, held to `card.ts` by the parity fixtures. It and its note show only once a mod has
pushed them. Without that, the line reads `Last prompt · 8.2 · +12 XP`, from the stream's `xp.granted`. A
celebration (level-up, epic or legendary loot, a mission done) plays its frames across the top rows, at the size the
pane allows.

**Missions**
```
 Daily · resets in 9h 12m                                   picks 1 of 3 left
 ▸ Clear Thinker   Write 5 prompts that make clear what you want    ███░░ 3/5
   Pinpoint        Write 3 prompts that point at exactly what …     ░░░ 0/3
 Weekly · resets Mon
 ▸ Wordsmith's Week  Get 25 prompts graded very well this week      ████░░░░ 11/25
```

**Loot**
```
 Worn                        Bag (14)
 head   Plain Cap   common   ◆ Sigil of Focus     rare      ×1.2
 frame  Ember Edge  epic     ◇ Rusty Gear         common
 sigil  Focus ×1.2  rare     ◇ Shard ×3           uncommon
 Recent drops: 13:55 Sigil of Focus (rare) · yesterday Ember Edge (epic)
```

**Stats**
```
 Prompts graded 212 · average 7.4 · best 9.3        (rubric 2 since Oct 20)
 intent 7.9  grounding 7.1  why 6.4  success 6.0  scope 8.2  forward 7.3
 Last 30 grades  ▅▆▄▇▆▅▆▇█▆▅▄▆▇▆▅▆▇▆▅▄▆▇▆▅▆▇▆▇▆   (from the stream)
 This run's prompts (your machine only)
 14:02  8.2  task        “Say which test should pass when it's done.”
 13:31  6.9  discussion  “Name the two options you're weighing.”   spelled: "recieve"
```
The grade history comes from the stream's `xp.granted` (the backfill and what follows), so it survives a restart.
"This run's prompts" holds what the mod pushed since the app started, the last 50, in memory only.

**Not in v1:** the shop, pet care, the welcome, the badges grid (Stats shows the count), leaderboards, profiles, the
map, actions and sound.

## The mod's side: the local channel
Unchanged in spirit: the mod pushes the private bits and the token to the app, which keeps them in memory. Restated
here as plain HTTP and JSON, so either side can be rewritten without the other.

**The request:** `POST /v1/watch` over the Unix socket `watch.sock`, HTTP/1.1, `content-type: application/json`, a body
of at most 64 KiB. Each hello replaces the last one from the same `sessionId` in full. `contract/hello.json`:
```json
{
  "v": 1,
  "clientVersion": "0.10.0",
  "sessionId": "01JB6Y3W8Q4D2N7K5M9P0R1S2T",
  "serverId": "srv_8f2c",
  "target": "online",
  "origin": "https://api.pathof.dev",
  "token": "pod_example_token",
  "scored": { "rubric": 2, "id": "p1", "kind": "task", "words": 42, "measures": { "intent": 9 }, "priced": null },
  "note": "Say which test should pass when it's done.",
  "misspelled": ["recieve"]
}
```
| Field | Type | Meaning |
|---|---|---|
| `v` | 1 | the protocol's version |
| `clientVersion` | string | the mod's version, `clientVersion` in `server.ts` |
| `sessionId`, `serverId` | string | the Claude Code session, and the server it plays on |
| `target` | `"local"`, `"dev"`, `"online"` | which server |
| `origin` | https origin | online only |
| `token` | string or `null` | online only; `null` after a logout, which drops the token for that origin |
| `scored` | object | the Last prompt card's input, `ScoredPrompt` as the session's state holds it (abbreviated above) |
| `note` | string | Haiku's note, from the coach's memory |
| `misspelled` | string[] | from the mod's memory only, as the card shows them |

`hello-local.json` carries only `v`, `clientVersion`, `sessionId`, `serverId` and `target`.

**The answers:** 204 taken; 400 a body that doesn't decode, or an unknown `v`, with `{ "v": 1 }` so the mod can say
which side to update; 409 another `serverId` than the one the app watches ("another session plays on dev"); 413 over
64 KiB.

**When the mod sends:** a session's start; after each stream answer, including an empty one after 25 s, so an app
started mid-session hears within 25 s; after a graded prompt; on a login, a logout or a server switch. Delivery is
best effort: a short timeout, and a failure is dropped silently, with no queue, retry or toast. When `watch.sock` isn't
there, the mod sends nothing.

**Where the socket lives:** `$PATHOFDEV_HOME/watch.sock`, else `~/.pathofdev/watch.sock` (`~/.pathofdev-dev` for the
dev sandbox). The app, not the mod, makes the home and checks it:
- `mkdir` 0700, then `chmod` 0700, as `local.ts` does;
- read with `symlink_metadata`: refused if it isn't a directory, is a symlink, isn't owned by `getuid()`, or others
  can write to it (`mode & 0o022`);
- bound under `umask(0o177)`, so the socket is 0600, and its mode checked after;
- the path's length checked (104 bytes on macOS, 108 on Linux, and the mod's limit of about 100);
- a second app finds the socket answering, says "already watching in another pane" and exits 0. A stale socket
  (nobody answers) is removed and bound again.

**How the mod finds the app** (`/pathofdev watch`, PR 5): it runs `pathofdev --version` with a 2 s timeout.
- **Missing:** it prints the install command (see "Distribution").
- **Older than the mod's `watchMinVersion`** (a constant in `server.ts`): it prints the upgrade command.
- **Fine:** it prints `pathofdev watch`, and offers `/pathofdev watch open`, which opens a split through
  `$.process.run` when the terminal can (`tmux split-window -h` under `$TMUX`, `zellij run -d right --`,
  `wezterm cli split-pane --right --`, `kitty @ launch --location=vsplit`), and otherwise says to open one.

## Distribution and install
The plugin can't carry the binary: it installs from the marketplace with no build step, and four binaries of about
2 MB each in the plugin's git history, on every release, would be worse than an install step.

| | What the player runs | Cost to us |
|---|---|---|
| **GitHub Releases, by dist 0.32** | `curl --proto '=https' --tlsv1.2 -LsSf https://github.com/eliraz-refael/path-of-dev/releases/download/pathofdev-v0.1.0/pathofdev-installer.sh \| sh` | `dist init` writes `release.yml`: a tag builds every target, uploads archives with checksums and the installer |
| **Homebrew tap** | `brew install eliraz-refael/pathofdev/pathofdev` | a repo `homebrew-pathofdev`; dist pushes the formula with a token scoped to it |
| **Nix flake** | `nix profile install github:eliraz-refael/path-of-dev#pathofdev` | the flake's `packages.pathofdev`, which the devShell PR adds anyway |
| **cargo** | `cargo install --git https://github.com/eliraz-refael/path-of-dev pathofdev --locked` | none |
| npm wrapper, inside the plugin | | rejected: Node again, or binaries in git |

- **Targets in v1:** `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-musl` and
  `aarch64-unknown-linux-musl`. Linux is built static with musl, so one binary runs on any distro (Open question 5).
  No Windows (Open question 2).
- **Which command the mod prints:** brew's when `brew` is on the PATH, nix's when `nix` is, else the curl line. It
  always adds the release page. The URL names the version the mod wants, not `latest`.
- **Versions, three ways:**
  - **The app and the mod:** the hello's `v`, and the mod's `watchMinVersion` against `pathofdev --version`. A hello
    for another `v` is answered 400, and the app shows "update the mod" or the mod "update pathofdev".
  - **The app and the server:** the server's `minClientVersion` names the mod's version. The app compares it with the
    hello's `clientVersion` and shows "update the mod" when the mod is behind. For itself, the app relies on lenient
    decoding, and says "this server is newer than pathofdev" when a snapshot no longer decodes.
  - **The header:** the app sends `PathOfDev-Client: watch/<version>`. The server reads it only for a presence, which
    the app never opens.
- **Signing on macOS: not needed for v1.**
  - curl doesn't set `com.apple.quarantine`, and neither does Homebrew for a formula (only for a cask), so Gatekeeper
    never checks a binary installed either way. A nix build is made on the machine.
  - Apple Silicon needs every binary signed, but Apple's linker signs it ad hoc on its own: the spike's shows
    `flags=0x20002(adhoc,linker-signed)`.
  - A binary downloaded by a browser is quarantined, and macOS refuses it ("cannot be verified"). The release notes
    say to run `xattr -d com.apple.quarantine ./pathofdev`, or to use the installer.
  - A Developer ID and notarization cost $99 a year and an Apple account's secrets in CI. Revisit if players hit it.
- **The v1 path:** dist's release workflow on a `pathofdev-v*` tag, with the shell installer and the tap; the flake's
  package; `cargo install --git`. The mod prints one of them.

## Privacy and security
- **Nothing new reaches a server.** The app sends only `GET /v1/snapshot` and `GET /v1/stream`, each carrying the
  cursor and the client header alone.
- **The private bits** (the note, the misspelled words) travel from the mod to the app over `watch.sock` alone. Neither
  side writes them to disk, logs them or sends them to a server. `docs/privacy.md` says today that they stay "in the
  mod's memory on your machine"; PR 3 widens that to "the mod's memory, and the companion's while it runs, on your
  machine". The misspelled words still never enter the session's state. The prompt's text is never pushed.
- **Who can reach the socket:** only the player's own user, as for `server.sock`: a 0600 socket in a 0700 home they
  own, both checked. Anything running as the same user could bind it first, but such a process can already read Claude
  Code's transcripts and store.
- **The token** is on no disk of ours. It lives in a `Token` newtype whose `Debug` prints `***`, so no panic message
  or log can show it. It rides only https to the origin it came with, never `server.sock` or `watch.sock`. A logout
  sends `null`, and a 401 drops it.
- **Least privilege:** the app holds the full game token but only sends GETs. A read-only token scope is "Later".
- **The terminal:** ratatui draws whatever a `Span` holds, escape bytes included. So every string from the server or
  a hello is stripped of control characters (C0, C1, ESC) when it is decoded, and a property checks it.
- **A crash** restores the terminal first: `ratatui::init` installs a panic hook that restores it before the default
  hook prints.

## Failure modes
| What happens | What the app shows or does |
|---|---|
| `pathofdev` not installed | `/pathofdev watch` prints the install command |
| `pathofdev` older than the mod wants | `/pathofdev watch` prints the upgrade command; a hello it can't read is a 400 |
| No app running | The mod finds no `watch.sock` and sends nothing |
| A stale `watch.sock` after a crash | The mod's send fails fast and is dropped. The next app removes it and binds again |
| A second app | "Already watching in another pane", then it exits 0 |
| The local server is down | "local · offline, start it with pnpm --filter @pathofdev/server start", retried |
| Online, with no hello yet | "Waiting for Claude Code to hand over your sign-in: start a session, or run /pathofdev watch" |
| 401 | "Signed out: /pathofdev login in Claude Code"; it waits for a hello with a new token |
| 429 | It waits the time the answer names |
| 503, a deploy, the network gone | "offline", with backoff to 30 s; it catches up from the cursor |
| `resync` | A new snapshot; the feed keeps its lines and marks the gap |
| A server without `/v1/snapshot` | "This server is older than pathofdev: update it" |
| A snapshot that no longer decodes | "This server is newer than pathofdev", with the upgrade command |
| A tiny pane, no truecolor | "Make this pane bigger"; 256 colours |
| A malformed or oversized hello | 400 or 413, ignored; the decoders never panic |
| A panic | The terminal is restored before it exits non-zero |

## Tests
Rust, in `crates/pathofdev/`, run by the `rust` job:
- **Properties** (proptest):
  - the stream machine: the cursor never goes back except on `resync`; `resync` and a newer `rulesVersion` always
    lead to a snapshot; after a 401 nothing goes online until a hello brings a token; backoff stays in 5–30 s, grows
    until an answer and resets on one; a stream request never carries `session`;
  - the hello decoder: total on arbitrary bytes and JSON; over 64 KiB refused; another `serverId` answered 409 and
    nothing changes;
  - the sanitizer: no decoded string holds a control character;
  - drawing: no line of any tab is wider than the pane, at every size from 40×16 up.
- **The contract:** every fixture decodes, and the unread fields equal `unread.txt`.
- **Parity:** the card and the frames against the TypeScript's text and colours; the glyph widths.
- **Screens:** each tab from the snapshot fixture, at 40, 80 and 120 columns, against `tests/screens/`.
- **Privacy canaries:** a canary in `note`, `misspelled` or `scored` never appears in a request the app makes, a file
  under the home, or its stderr. The token reaches only its https origin, and never a socket.
- **Glue,** against a fake server made with tiny_http, over TCP and a Unix socket: a snapshot, an event on the stream,
  a `resync`, a 401 and a token handoff, a 429, the server stopped and started. The home checks in a temp dir: 0700
  made, a group-writable or foreign home refused, the socket 0600, a second instance exits, a stale socket replaced.

TypeScript, run by `ci` and `mod`:
- the contract tests that write and compare `contract/`;
- the mod's push in `pathofdev.test.ts`, against a fake `watch.sock`: a graded prompt pushes the card, the note and
  the words; with no socket no request is made; a logout pushes `token: null`;
- `/pathofdev watch`: missing, old and current binaries, with `$.process.run` faked.

Manual, recorded in each PR: a tmux split and a second tab, on macOS and Linux, local and online.

## PR breakdown (in order)
0. **The read-only snapshot (server, in flight on `watch-snapshot`).** `GET /v1/snapshot` and its pinned fixture. It
   is deployed online before PR 3 ships.
1. **PR 1: the toolchain, the contract and Home, local.**
   - `flake.nix` and `flake.lock` (devShell, `packages.pathofdev`), root `Cargo.toml`, `Cargo.lock`,
     `rust-toolchain.toml`, `.gitignore`, `.dockerignore`;
   - `crates/pathofdev/`: flags, the home and socket checks (bound, answering 400 to every hello for now), the stream
     machine on `server.sock`, Home without the card, the sprite;
   - `contract/` with `snapshot.json` and the stream answers, `packages/server/test/contract.test.ts`, the sprite
     export in `packages/mod/test/contract.prop.ts`, `pnpm contract`;
   - the `rust` CI job.
   - It touches no server source and no mod hook.
2. **PR 2: releases.** `dist-workspace.toml` and `.github/workflows/release.yml` from `dist init`, the
   `homebrew-pathofdev` repo and its secret, a `nix build .#pathofdev` CI step, and a first pre-release tag
   (`pathofdev-v0.1.0-alpha.1`) to prove every target and installer. The release page's quarantine note.
3. **PR 3: the channel and the card.**
   - The mod: `hooks/watch.ts` (`helloOf`, `watchSocketOf`) and the pushes in `register.tsx`; `plugin.json` bumped;
   - the app: `POST /v1/watch`, the token handoff and the online target, the Last prompt card, "This run's prompts";
   - `contract/hello*.json`, `card/`, `glyphs.json`, and their parity tests;
   - the `docs/privacy.md` wording, and the canary and token tests.
   - *Tell the online session:* a new client now polls `/v1/snapshot` and `/v1/stream` without presence, and
     `privacy.md` changed.
4. **PR 4: the other tabs and the celebrations.** Missions, Loot and Stats with the history; `assets/looks.json`
   and the frames, with their parity fixtures.
5. **PR 5: discovery and 0.1.0.** `/pathofdev watch` (find, install, upgrade) and `watch open`; `watchMinVersion`;
   the pane's footer line ("More room? /pathofdev watch"), the welcome's last step, a README section, the `band`
   option's description; `plugin.json` bumped; the `pathofdev-v0.1.0` tag.

No PR touches `public.ts`, `auth/*`, `players.ts`, `profile*`, `pages.ts` or `migrations.ts`. Only PR 1 and PR 3 add
test files under `packages/server` and `packages/mod`.

## Later
- **A web view:** the app serves a page on `127.0.0.1` with a one-time token in the URL, from the same state, so the
  private bits still never leave the machine.
- **Actions** through `POST /v1/commands`: equip, accept, buy.
- **The map,** once the game has one.
- **A read-only token scope,** with the online session, if the app ever runs where the mod doesn't.
- **Windows,** crates.io and notarization (Open questions 2, 6 and 7).

## Open questions (for the player)
1. **What is the binary called?** `pathofdev`, run as `pathofdev watch`, or `pathofdev-watch`?
   - **Recommendation: `pathofdev`.** `pathofdev watch` is the name the plan, the README and `/pathofdev watch` already
     use, and a later `pathofdev web` fits beside it. The name is free on crates.io and needs no tap of a second
     name. A bare `pathofdev` prints its help.
2. **Windows in v1?**
   - **Recommendation: no.** Windows 10 has Unix sockets, but the home's checks would be ACLs, not modes, and the mod's
     socket paths and the local server are untested there. dist adds `x86_64-pc-windows-msvc` and a PowerShell
     installer when players ask.
3. **How are releases cut, and how are they versioned?**
   - **Recommendation: on their own.** The app has its own semver and its own tags (`pathofdev-v0.1.0`), cut by hand
     from main when the app changed, not with every mod bump. The mod names the oldest app it works with
     (`watchMinVersion`), and the app the protocol (`v`), so either can move alone.
4. **A Homebrew tap, though the owner uses nix?**
   - **Recommendation: yes.** Many macOS players have brew, and dist writes and pushes the formula. The owner never runs
     it: the release workflow installs the formula on a macOS runner once, as its smoke test.
5. **Linux: static musl or glibc?**
   - **Recommendation: musl.** One static binary runs on every distro and in containers. ring builds for musl, and
     nothing here is fast enough for musl's allocator to matter.
6. **Publish to crates.io?**
   - **Recommendation: not in v1.** `cargo install --git` serves Rust players without a publish step or a
     crates.io token. The crate is already laid out to publish (its assets live inside it) once it settles.
7. **Notarize on macOS?**
   - **Recommendation: not in v1.** The installer, brew and nix never quarantine the binary. Only a browser download
     does, and the release notes cover it.
8. **May the companion's toolchain land in a root `flake.nix`?**
   - **Recommendation: yes,** with only the Rust tools in its devShell, and the package. It is how the owner works,
     the spike needed it on macOS, and it doubles as the nix install.
