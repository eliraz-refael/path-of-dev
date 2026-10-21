import type { CheckoutRef, ClientEvent, CommitRef, RepoRef, WorkRef } from '@pathofdev/schema'
import type { CommandSource, SessionCompactTrigger } from 'claude-code'
import { hmac } from './ids'
import { isAssignment, programOf, simpleCommands } from './shell'
import type { Target } from './server'

// What the mod reads off the work around it: which repo a session is in, and what a Bash call did. It only ever
// names a repo it can tell is on GitHub; anything else goes as opaque keys, so no path or remote leaves the machine.

/** The session's repo: named when its remote is on GitHub, else known only by its remote or folder. */
export type Repo = { kind: 'github'; name: string } | { kind: 'other'; id: string }

const githubRemote = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/

/** The path a GitHub remote names its repo by: `owner/name`, `.git` after it or not. */
const githubPath = /^([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/

/**
 * The repo a `git remote get-url origin` output names, or null when it isn't a GitHub remote. `alias` is an ssh host
 * that resolves to github.com (`git@work:acme/widgets.git`, `Host work` with `HostName github.com`), read as GitHub's.
 */
export const githubName = (remote: string, alias: string | null = null): string | null => {
  const trimmed = remote.trim()
  const ssh = alias === null ? null : sshRemoteOf(trimmed)
  return ssh !== null && ssh.host === alias
    ? (githubPath.exec(ssh.path)?.[1] ?? null)
    : (githubRemote.exec(trimmed)?.[1] ?? null)
}

export const repoOf = (remote: string | null, folder: string, alias: string | null = null): Repo => {
  const name = remote === null ? null : githubName(remote, alias)
  return name === null ? { kind: 'other', id: remote?.trim() || folder } : { kind: 'github', name }
}

/**
 * How subjects name their repo for a target: by name to a local server, the player's own, and never online, where
 * only opaque keys go until a verifier can tell a repo is public.
 */
export type SubjectForm = 'named' | 'private'

export const subjectFormOf = (target: Target): SubjectForm => (target.kind === 'online' ? 'private' : 'named')

/** The repo as subjects of `form` see it: the private form knows a GitHub repo only by its name, kept as a key. */
export const repoIn = (form: SubjectForm, repo: Repo): Repo =>
  form === 'private' && repo.kind === 'github' ? { kind: 'other', id: repo.name } : repo

/** The keys a subject carries: one over the repo alone, one over the repo and the subject's own fields. */
const keys = async (secret: string, repo: Repo, fields: string) => {
  const id = repo.kind === 'github' ? repo.name : repo.id
  return { repoKey: await hmac(secret, `repo|${id}`), key: await hmac(secret, `${fields}|${id}`) }
}

export const repoRef = async (secret: string, repo: Repo): Promise<RepoRef> => {
  const { repoKey, key } = await keys(secret, repo, 'repo')
  return repo.kind === 'github' ? { type: 'github', repo: repo.name, key } : { type: 'private', repo: repoKey, key }
}

export const commitRef = async (secret: string, repo: Repo, sha: string): Promise<CommitRef> => {
  const { repoKey, key } = await keys(secret, repo, `commit|${sha}`)
  return repo.kind === 'github' ? { type: 'github', repo: repo.name, sha, key } : { type: 'private', repo: repoKey, key }
}

export const workRef = async (secret: string, repo: Repo, number: number): Promise<WorkRef> => {
  const { repoKey, key } = await keys(secret, repo, `work|${number}`)
  return repo.kind === 'github' ? { type: 'github', repo: repo.name, number, key } : { type: 'private', repo: repoKey, key }
}

export const checkoutRef = async (secret: string, repo: Repo, branch: string | null): Promise<CheckoutRef> => {
  const { repoKey, key } = await keys(secret, repo, `checkout|${branch ?? ''}`)
  return repo.kind === 'github'
    ? { type: 'github', repo: repo.name, branch, headSha: null, key }
    : { type: 'private', repo: repoKey, key }
}

// What runs a command without being it: `CI=1`, `env`, `time`, `timeout 60`, a group's brace, a loop's `do`.
const wrappers = new Set(['{', '}', '!', 'then', 'do', 'else', 'env', 'time', 'command', 'exec', 'nohup', 'nice'])

/** The words a simple command runs, what only sets it up skipped: `CI=1 timeout 60 pnpm test` runs `pnpm test`. */
const argvOf = (words: ReadonlyArray<string>): ReadonlyArray<string> => {
  let i = 0
  for (;;) {
    const word = words[i]
    if (word === undefined) return []
    if (isAssignment(word) || wrappers.has(word)) i += 1
    else if (word === 'timeout') {
      i += 1
      while (words[i]?.startsWith('-') === true) i += 1
      i += 1
    } else return words.slice(i)
  }
}

// The options of a package manager that take the next word for their value (pnpm's `-w` is a flag, npm's is not).
const valued: Record<string, ReadonlySet<string>> = {
  npm: new Set(['-w', '--workspace', '--prefix', '-C', '--loglevel']),
  pnpm: new Set(['-F', '--filter', '--filter-prod', '-C', '--dir', '--reporter', '--loglevel', '--test-pattern']),
  yarn: new Set(['--cwd']),
  bun: new Set(['--cwd', '-F', '--filter']),
}

/** The words past a package manager's options: `pnpm -s --filter x test` comes to `test`. */
const pastOptions = (manager: string, words: ReadonlyArray<string>): ReadonlyArray<string> => {
  let i = 0
  while (words[i]?.startsWith('-') === true) i += valued[manager]?.has(words[i] ?? '') === true ? 2 : 1
  return words.slice(i)
}

/** A package script that runs the tests, by its name: `test`, or one of its kind (`test:unit`, `test-e2e`). */
const isTestScript = (name: string | undefined): boolean => name !== undefined && /^test(?:[:._-]\S*)?$/.test(name)

const managers = new Set(['npm', 'pnpm', 'yarn', 'bun'])

/** The runner `argv` starts, through a package manager's script or its `exec`, or null when it starts none. */
const runnerOf = (argv: ReadonlyArray<string>): string | null => {
  const [first, ...rest] = argv
  if (first === undefined) return null
  const program = programOf(first)
  if (managers.has(program)) {
    const [sub, ...more] = pastOptions(program, rest)
    if (sub === 'test' || sub === 't' || sub === 'tst' || sub === 'recursive') {
      return sub === 'recursive' ? runnerOf([program, ...more]) : 'npm'
    }
    if (sub === 'run' || sub === 'run-script') return isTestScript(pastOptions(program, more)[0]) ? 'npm' : null
    if (sub === 'exec' || sub === 'dlx' || sub === 'x') return runnerOf(pastOptions(program, more))
    if (sub === 'workspace' && program === 'yarn') return runnerOf([program, ...more.slice(1)])
    // pnpm, yarn and bun run a script, or a package's own program, by its name alone.
    if (program === 'npm' || sub === undefined) return null
    return isTestScript(sub) ? 'npm' : runnerOf([sub, ...more])
  }
  const [sub, ...more] = rest
  switch (program) {
    case 'npx':
    case 'bunx':
      return runnerOf(pastOptions('npm', rest))
    case 'vitest':
    case 'jest':
      return program
    case 'pytest':
    case 'py.test':
      return 'pytest'
    case 'python':
    case 'python3':
      return sub === '-m' && more[0] === 'pytest' ? 'pytest' : null
    case 'uv':
    case 'poetry':
    case 'pipenv':
      return sub === 'run' ? runnerOf(more) : null
    case 'bundle':
      return sub === 'exec' ? runnerOf(more) : null
    case 'rspec':
      return 'rspec'
    case 'go':
      return sub === 'test' ? 'go' : null
    case 'cargo': {
      // A toolchain first (`cargo +nightly test`), then cargo's own flags.
      const [verb] = pastOptions(program, sub?.startsWith('+') === true ? more : rest)
      return verb === 'test' || verb === 'nextest' ? 'cargo' : null
    }
    case 'mix':
      return sub === 'test' ? 'mix' : null
    case 'dotnet':
      return sub === 'test' ? 'dotnet' : null
    case 'deno':
      return sub === 'test' ? 'deno' : null
    case 'node':
      return rest.includes('--test') ? 'node' : null
    case 'claude':
      return sub === 'plugin' && more[0] === 'test' ? 'claude' : null
    case 'sbt':
      return rest.includes('test') ? 'sbt' : null
    case 'mvn':
    case 'mvnw':
      return rest.includes('test') ? 'maven' : null
    case 'gradle':
    case 'gradlew':
      return rest.includes('test') ? 'gradle' : null
    default:
      return null
  }
}

/**
 * The test runner a Bash command runs, or null when it runs none: by the programs its simple commands start, so one
 * that only names a runner (`echo "pnpm test"`, `grep -r vitest`, a commit message) runs none.
 */
export const testRunner = (command: string): string | null => {
  for (const one of simpleCommands(command)) {
    const runner = runnerOf(argvOf(one.words))
    if (runner !== null) return runner
  }
  return null
}

/**
 * Whether the command's exit code is the test run's. A pipe hands back the last command's code (`vitest | tail`
 * exits 0 on a failure), as do `;` and a new line (`vitest; echo done`); `||` turns a failure into whatever its
 * right side answers (`vitest || true`), and a trailing `&` sends the run to the background. Any of these, and the
 * code says nothing about the tests. `&&` stops at the first failure, so its code stays a failure's; redirects
 * (`2>&1`, `&>`) are no separators, nor is what a quote or a heredoc holds.
 */
export const exitIsTheRuns = (command: string): boolean => {
  const commands = simpleCommands(command)
  return commands.every(
    (one, i) => one.then !== '&' && (i === commands.length - 1 || one.then === '&&' || one.then === '(' || one.then === ')'),
  )
}

/** What a line of a test run's output says of it: a count of failures says failed, a count of passes passed. */
type Said = 'passed' | 'failed' | null

const countOf = (text: string, word: string): number => Number(new RegExp(`(\\d+) ${word}`).exec(text)?.[1] ?? 0)

/** Counts: failed once one names a failure or an error, passed once one names a pass, else nothing. */
const byCounts = (text: string, failures: ReadonlyArray<string>, passes: string): Said =>
  failures.some((word) => countOf(text, word) > 0) ? 'failed' : countOf(text, passes) > 0 ? 'passed' : null

// The summary lines runners end on, each read by what it counts. vitest: `Tests  1 failed | 4 passed (5)`; jest:
// `Tests:       1 failed, 4 passed, 5 total`; bun and `claude plugin test`: ` 4 pass` and ` 1 fail`; node:test:
// `ℹ fail 1`; pytest: `=== 1 failed, 4 passed in 0.12s ===`; cargo: `test result: FAILED. 4 passed; 1 failed;`;
// go: a package's `ok` or `FAIL` line. A package manager's own line for a script that failed says failed too.
const summaries: ReadonlyArray<[RegExp, (match: RegExpExecArray) => Said]> = [
  [/^(?:Test Files|Tests)\s{2,}(.+) \(\d+\)$/, (match) => byCounts(match[1] ?? '', ['failed'], 'passed')],
  [/^Errors\s{2,}\d+ errors?$/, () => 'failed'],
  [/^(?:Tests|Test Suites):\s+(.+), \d+ total$/, (match) => byCounts(match[1] ?? '', ['failed'], 'passed')],
  [/^(\d+) (pass|fail)$/, (match) => (match[1] === '0' ? null : match[2] === 'fail' ? 'failed' : 'passed')],
  [/^[ℹ#] (pass|fail) (\d+)$/, (match) => (match[2] === '0' ? null : match[1] === 'fail' ? 'failed' : 'passed')],
  [
    /^=*\s*((?:\d+ (?:failed|passed|errors?|skipped|xfailed|xpassed|warnings?|deselected|rerun)(?:, )?)+) in [\d.]+s\b.*$/,
    (match) => byCounts(match[1] ?? '', ['failed', 'error', 'errors'], 'passed'),
  ],
  [/^test result: (?:ok|FAILED)\. (.+)$/, (match) => byCounts(match[1] ?? '', ['failed'], 'passed')],
  [/^(?:FAIL\s+\S+\s+(?:[\d.]+s|\[[^\]]+\])|FAIL|--- FAIL: .*)$/, () => 'failed'],
  [/^(?:ok\s+\S+\s+(?:[\d.]+s|\(cached\)).*|PASS)$/, () => 'passed'],
  [/ELIFECYCLE\s+(?:Test|Command) failed|ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL/, () => 'failed'],
  [/^npm (?:ERR!|error) (?:Test failed|Lifecycle script `[^`]+` failed|code ELIFECYCLE)/, () => 'failed'],
  [/^error Command failed with exit code [1-9]\d*\.?$/, () => 'failed'],
]

const colours = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

/**
 * Whether a test run's output says it passed or failed, from the summary its runner ends on, for a run whose exit
 * code another command took (`pnpm test 2>&1 | tail -20`): failed once any summary counts a failure, passed once
 * one counts a pass and none a failure, null when none is there to read.
 */
export const outcomeOf = (output: string): 'passed' | 'failed' | null => {
  let outcome: Said = null
  for (const row of output.replace(colours, '').split('\n')) {
    const line = row.trim()
    for (const [pattern, read] of summaries) {
      const match = pattern.exec(line)
      const said = match === null ? null : read(match)
      if (said === 'failed') return 'failed'
      if (said === 'passed') outcome = 'passed'
    }
  }
  return outcome
}

/**
 * Where each `git commit` a command line runs, as the `-C` arguments that take git there from the directory the
 * call starts in: a `cd` before it, then git's own `-C`s. A commit is told by HEAD moving, not by what it prints, so
 * `-q` hides none. A commit where the line can't say (`cd "$dir"`, `--git-dir`) has no place here.
 */
export const commitsIn = (command: string, home: string | undefined): ReadonlyArray<ReadonlyArray<string>> => {
  const commits: Array<ReadonlyArray<string>> = []
  let at: ReadonlyArray<string> | null = []
  for (const one of simpleCommands(command)) {
    const [first, ...rest] = argvOf(one.words)
    if (first === 'cd' || first === 'pushd') {
      const dir = rest.length === 1 ? placeOf(rest[0] ?? '', home) : null
      at = at === null || dir === null ? null : [...at, '-C', dir]
    } else if (first === 'popd') at = null
    else if (first !== undefined && programOf(first) === 'git') {
      const commit = commitAt(rest, at)
      if (commit !== null) commits.push(commit)
    }
  }
  return commits
}

/** A folder named on the command line, `~` read as home, or null for one only the shell could say (`$dir`, `-`). */
const placeOf = (word: string, home: string | undefined): string | null => {
  const dir = word === '~' || word.startsWith('~/') ? (home === undefined ? null : home + word.slice(1)) : word
  return dir === null || dir === '' || dir === '-' || /[$`*?[~]/.test(dir) ? null : dir
}

/** The place a `git` invocation commits at, from `at` and its own options, or null when it is no commit. */
const commitAt = (args: ReadonlyArray<string>, at: ReadonlyArray<string> | null): ReadonlyArray<string> | null => {
  let place = at
  let i = 0
  for (;;) {
    const arg = args[i]
    if (arg === undefined || !arg.startsWith('-')) break
    if (arg === '-C') {
      const dir = placeOf(args[i + 1] ?? '', undefined)
      place = place === null || dir === null ? null : [...place, '-C', dir]
      i += 2
    } else if (arg === '--git-dir' || arg === '--work-tree') {
      place = null
      i += 2
    } else if (arg.startsWith('--git-dir=') || arg.startsWith('--work-tree=')) {
      place = null
      i += 1
    } else i += arg === '-c' || arg === '--namespace' || arg === '--config-env' ? 2 : 1
  }
  return args[i] === 'commit' ? place : null
}

/** An ssh remote's host and path: `git@work:acme/widgets.git` or `ssh://git@work:22/acme/widgets.git`. */
const sshRemoteOf = (remote: string): { host: string; path: string } | null => {
  const found =
    /^ssh:\/\/(?:[^@/]+@)?([^/:@]+)(?::\d+)?\/(.+)$/.exec(remote) ?? /^(?:[^@/:]+@)?([^/:@]+):(?!\/)(.+)$/.exec(remote)
  return found === null ? null : { host: found[1] ?? '', path: found[2] ?? '' }
}

/** A remote's ssh host when it names one of its own (`git@work:acme/widgets.git`), not github.com, else null. */
export const sshAliasOf = (remote: string): string | null => {
  const host = sshRemoteOf(remote.trim())?.host ?? null
  return host !== null && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host) && host.toLowerCase() !== 'github.com' ? host : null
}

/** The host name `ssh -G` resolves an alias to, from its output (`hostname github.com`). */
export const hostNameOf = (config: string): string | null =>
  /^hostname\s+(\S+)$/m.exec(config)?.[1]?.toLowerCase() ?? null

type DataOf<Type extends ClientEvent['type']> = Extract<ClientEvent, { type: Type }>['data']

// The server's pattern for a command's name; one it would refuse goes as `custom`.
const commandPattern = /^\/[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/

/**
 * The name a slash command is counted under: a built-in's or a plugin's by name (`/compact`, `/plugin:name`), and
 * the player's own, an MCP server's or one the session doesn't list as `custom`, since those names may reveal
 * private work.
 */
export const commandNameOf = (
  command: string,
  source: CommandSource | undefined,
): DataOf<'command.used'>['command'] => {
  const name = `/${command}`
  return (source === 'builtin' || source === 'plugin') && commandPattern.test(name) ? name : 'custom'
}

/**
 * A compaction as the stats count it: the player's `/compact` is manual, the engine's or a plugin's auto. A
 * precompute installs nothing, so it is no compaction.
 */
export const compactionOf = (trigger: SessionCompactTrigger): DataOf<'session.compacted'>['trigger'] | null =>
  trigger === 'manual' ? 'manual' : trigger === 'precompute' ? null : 'auto'

/** What the mod keeps of the ssh aliases it resolved: each one's host name, or null for none, and when it asked. */
export type SshHosts = Record<string, { host: string | null; at: number }>

/** How long a resolved alias is kept before `ssh -G` is asked again: a day, as an ssh config seldom changes. */
export const sshHostMs = 24 * 60 * 60 * 1000

/** The aliases the store holds, those in another shape left out. */
export const sshHostsOf = (stored: unknown): SshHosts => {
  if (typeof stored !== 'object' || stored === null) return {}
  const hosts: SshHosts = {}
  for (const [alias, kept] of Object.entries(stored)) {
    if (typeof kept !== 'object' || kept === null || !('host' in kept) || !('at' in kept)) continue
    const { host, at } = kept
    if ((typeof host === 'string' || host === null) && typeof at === 'number') hosts[alias] = { host, at }
  }
  return hosts
}

/** The host an alias resolved to at most `sshHostMs` before `now` (null for none), or undefined to ask again. */
export const keptHostOf = (hosts: SshHosts, alias: string, now: number): string | null | undefined => {
  const kept = hosts[alias]
  return kept === undefined || now - kept.at > sshHostMs || kept.at > now ? undefined : kept.host
}
