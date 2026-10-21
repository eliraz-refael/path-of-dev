import { it as prop } from '@effect/vitest'
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  commitsIn,
  exitIsTheRuns,
  githubName,
  hostNameOf,
  keptHostOf,
  outcomeOf,
  sshAliasOf,
  sshHostMs,
  testRunner,
} from '../hooks/observe'

// What the mod reads off a Bash call, as properties over the shapes commands and their output come in: the test
// runner a command starts, however it is wrapped and piped, and none from one that only names it; whether a run
// passed, from its runner's summary however much of the output a pipe kept; where a commit runs; and a remote through
// an ssh alias for github.com. The shapes include the ones real sessions ran, none of which counted before.

const between = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }))

/** Test commands as people type them, each with the runner the mod counts it under. */
const runs: ReadonlyArray<readonly [string, string]> = [
  ['pnpm test', 'npm'],
  ['pnpm -s test', 'npm'],
  ['pnpm -r test', 'npm'],
  ['pnpm -r --parallel test', 'npm'],
  ['pnpm --filter @acme/widgets test', 'npm'],
  ['pnpm --filter=@acme/widgets test', 'npm'],
  ['pnpm -C packages/mod test', 'npm'],
  ['pnpm run test:unit', 'npm'],
  ['pnpm test:e2e', 'npm'],
  ['pnpm exec vitest run', 'vitest'],
  ['pnpm vitest run', 'vitest'],
  ['npm test', 'npm'],
  ['npm run test', 'npm'],
  ['npm -w packages/a test', 'npm'],
  ['yarn test', 'npm'],
  ['yarn workspace @acme/a test', 'npm'],
  ['bun test', 'npm'],
  ['npx vitest run', 'vitest'],
  ['npx --yes vitest', 'vitest'],
  ['node_modules/.bin/vitest run packages/mod/test', 'vitest'],
  ['npx jest --ci', 'jest'],
  ['jest', 'jest'],
  ['node --test test/', 'node'],
  ['claude plugin test packages/mod', 'claude'],
  ['cargo test', 'cargo'],
  ['cargo +nightly nextest run', 'cargo'],
  ['go test ./...', 'go'],
  ['pytest -q', 'pytest'],
  ['python3 -m pytest tests', 'pytest'],
  ['uv run pytest', 'pytest'],
  ['bundle exec rspec', 'rspec'],
  ['./gradlew clean test', 'gradle'],
  ['mvn -q test', 'maven'],
  ['dotnet test', 'dotnet'],
]

const Run = Schema.Struct({
  run: between(0, runs.length - 1),
  before: Schema.Literals(['', 'cd /work/widgets && ', 'CI=1 ', 'env FORCE_COLOR=0 ', 'timeout 600 ', 'time ']),
  args: Schema.Literals(['', ' src', ' --reporter=dot']),
  redirect: Schema.Literals(['', ' 2>&1', ' 2>/dev/null']),
  after: Schema.Literals(['', ' | tail -20', ' | tail -n 5', ' | head -50', ' | tee out.log', '; echo done', ' || true', ' && echo ok']),
})

/** The commands that only name a runner, in words a commit message, an echo, a search or a heredoc holds. */
const Mention = Schema.Struct({
  run: between(0, runs.length - 1),
  shape: between(0, 8),
})
const mentionOf = (run: string, shape: number): string =>
  [
    `echo "${run}"`,
    `git commit -m "Run ${run} on every push"`,
    `grep -rn "${run}" .`,
    `cat <<'EOF' > notes.md\n${run}\nEOF`,
    `git add -A && git commit -q -m "$(cat <<'EOF'\nMake "${run}" pass\n\n${run}\nEOF\n)"`,
    `ls # ${run}`,
    `rg '${run}' docs`,
    `printf '%s\\n' '${run}' | tee steps.txt`,
    `echo $(echo ${run})`,
  ][shape] ?? ''

describe('the test runner a command starts', () => {
  prop.prop('is found behind any wrapper, args, redirect and pipe', [Run], ([drawn]) => {
    const [run, runner] = runs[drawn.run] ?? ['', '']
    expect(testRunner(`${drawn.before}${run}${drawn.args}${drawn.redirect}${drawn.after}`)).toBe(runner)
  })

  prop.prop('owns the exit code only when nothing after it can take it', [Run], ([drawn]) => {
    const [run] = runs[drawn.run] ?? ['']
    const command = `${drawn.before}${run}${drawn.args}${drawn.redirect}${drawn.after}`
    expect(exitIsTheRuns(command)).toBe(drawn.after === '' || drawn.after === ' && echo ok')
  })

  it('owns no exit code a `!` turns over, and is found behind an `if`', () => {
    expect(exitIsTheRuns('! pnpm test')).toBe(false)
    expect(exitIsTheRuns('cd a && ! vitest run')).toBe(false)
    expect(testRunner('if pnpm test; then echo ok; fi')).toBe('npm')
  })

  prop.prop('is none in a command that only names one', [Mention], ([drawn]) => {
    const [run] = runs[drawn.run] ?? ['']
    expect(testRunner(mentionOf(run, drawn.shape))).toBeNull()
  })

  it('is none for a command that runs something else in a test folder', () => {
    for (const command of ['cat test/until.ts', 'ls packages/mod/test', 'mkdir -p test && cd test', 'git diff -- test']) {
      expect(testRunner(command)).toBeNull()
    }
  })
})

/** How a runner ends its output: its summary, for `failed` failures and `passed` passes. */
const formats: ReadonlyArray<(failed: number, passed: number) => ReadonlyArray<string>> = [
  // vitest
  (failed, passed) => [
    ` Test Files  ${failed > 0 ? '1 failed | ' : ''}${passed > 0 ? '3 passed ' : ''}(${failed > 0 ? 4 : 3})`,
    `      Tests  ${[failed > 0 ? `${failed} failed` : '', passed > 0 ? `${passed} passed` : ''].filter(Boolean).join(' | ')} (${failed + passed})`,
    '   Start at  12:00:00',
    '   Duration  1.20s (transform 70%, tests 20%)',
  ],
  // jest
  (failed, passed) => [
    `Test Suites: ${failed > 0 ? '1 failed, ' : ''}2 total`,
    `Tests:       ${[failed > 0 ? `${failed} failed` : '', passed > 0 ? `${passed} passed` : ''].filter(Boolean).join(', ')}, ${failed + passed} total`,
    'Time:        1.2 s',
  ],
  // bun, and `claude plugin test`
  (failed, passed) => [` ${passed} pass`, ` ${failed} fail`, `Ran ${failed + passed} tests across 5 files. [57.40s]`],
  // node:test
  (failed, passed) => [`ℹ tests ${failed + passed}`, 'ℹ suites 0', `ℹ pass ${passed}`, `ℹ fail ${failed}`, 'ℹ duration_ms 41'],
  // pytest
  (failed, passed) => [
    `===== ${[failed > 0 ? `${failed} failed` : '', passed > 0 ? `${passed} passed` : '', '1 warning'].filter(Boolean).join(', ')} in 0.42s =====`,
  ],
  // cargo
  (failed, passed) => [
    `test result: ${failed > 0 ? 'FAILED' : 'ok'}. ${passed} passed; ${failed} failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s`,
  ],
  // go
  (failed) =>
    failed > 0
      ? ['--- FAIL: TestParse (0.00s)', 'FAIL', 'FAIL\tgithub.com/acme/widgets\t0.012s']
      : ['ok  \tgithub.com/acme/widgets\t0.012s'],
]

/** Lines a run prints along the way, none of them a summary. */
const noise = [
  ' RUN  v5.0.3 /work/widgets',
  ' ✓ test/parse.test.ts (12 tests) 4ms',
  'stdout | test/parse.test.ts > parses',
  '> widgets@1.0.0 test /work/widgets',
  '> vitest run',
  'running 12 tests',
  'test parse::works ... ok',
  'collected 7 items',
  '=== RUN   TestParse',
  '',
  'Tests are fun to write',
]

const Output = Schema.Struct({
  format: between(0, formats.length - 1),
  failed: between(0, 5),
  passed: between(1, 400),
  before: Schema.Array(between(0, noise.length - 1)).check(Schema.isMaxLength(30)),
  isColoured: Schema.Boolean,
  wrapper: Schema.Literals(['', ' ELIFECYCLE  Test failed. See above for more details.', 'npm error Lifecycle script `test` failed with error:']),
  kept: between(0, 40),
})

const colour = (line: string) => (line === '' ? line : `\u001b[1m\u001b[32m${line}\u001b[39m\u001b[22m`)

describe('a test run read by its summary', () => {
  prop.prop('says failed once a failure is counted, else passed, however much a tail kept', [Output], ([drawn]) => {
    const summary = formats[drawn.format]?.(drawn.failed, drawn.passed) ?? []
    const wrapper = drawn.failed > 0 && drawn.wrapper !== '' ? [drawn.wrapper] : []
    const lines = [...drawn.before.map((i) => noise[i] ?? ''), ...summary, ...wrapper]
    // A tail keeps the summary's lines, and as many of the ones before it as it reaches.
    const tail = lines.slice(-Math.max(summary.length + wrapper.length, drawn.kept))
    const output = (drawn.isColoured ? tail.map(colour) : tail).join('\n')
    expect(outcomeOf(output)).toBe(drawn.failed > 0 ? 'failed' : 'passed')
  })

  prop.prop('says nothing without a summary', [Output], ([drawn]) => {
    expect(outcomeOf(drawn.before.map((i) => noise[i] ?? '').join('\n'))).toBeNull()
  })
})

/** A `git commit` as an agent runs it: where, with which flags, and what comes after. */
const Commit = Schema.Struct({
  cd: Schema.Literals(['', '/work/widgets', '../gadgets', '~/work/widgets', '"$WORKTREE"']),
  dir: Schema.Literals(['', '/work/widgets-worktrees/fix', '../gadgets', 'sub dir']),
  options: Schema.Literals(['', '-c user.name=Ada ', '--no-pager ']),
  flags: Schema.Literals([
    '-m "Add widgets"',
    '-q -m "Add widgets"',
    '-qm "Fix the commit parser"',
    '--amend --no-edit -q',
    `-q -F - <<'EOF'\nAdd widgets\n\ngit commit -m twice\nEOF`,
    `-q -m "$(cat <<'EOF'\nAdd "widgets"\n\nEOF\n)"`,
  ]),
  after: Schema.Literals(['', ' 2>&1 | tail -2', ' && git push', '; git log -1 --oneline']),
})

const home = '/home/player'

describe('where a command commits', () => {
  prop.prop('is the cd before it, then its own -C, read as git reads them', [Commit], ([drawn]) => {
    const cd = drawn.cd === '' ? '' : `cd ${drawn.cd} && `
    const dir = drawn.dir === '' ? '' : `-C ${drawn.dir.includes(' ') ? `'${drawn.dir}'` : drawn.dir} `
    const command = `git add -A && ${cd}git ${dir}${drawn.options}commit ${drawn.flags}${drawn.after}`
    const fromCd = drawn.cd === '' ? [] : ['-C', drawn.cd.replace(/^~/, home)]
    const fromDir = drawn.dir === '' ? [] : ['-C', drawn.dir]
    expect(commitsIn(command, home)).toEqual(drawn.cd.startsWith('"') ? [] : [[...fromCd, ...fromDir]])
  })

  it('is nowhere for a git command that commits nothing', () => {
    for (const command of [
      'git log --grep commit',
      'git show HEAD',
      'git status && echo commit',
      'git commit-tree HEAD^{tree}',
      'echo git commit',
      'git --git-dir=.git commit -m x',
    ]) {
      expect(commitsIn(command, home)).toEqual([])
    }
  })

  it('counts each commit the line runs', () => {
    expect(commitsIn('git commit -qm a && git -C ../b commit -qm b && git commit -qm c', home)).toEqual([[], ['-C', '../b'], []])
  })

  it('keeps a cd in a subshell inside it', () => {
    expect(commitsIn('(cd sub && git commit -qm a); git commit -qm b', home)).toEqual([['-C', 'sub'], []])
    expect(commitsIn('(cd a); (cd b && git commit -qm b)', home)).toEqual([['-C', 'b']])
    expect(commitsIn('cd a && (cd b && git commit -qm b) && git commit -qm a', home)).toEqual([
      ['-C', 'a', '-C', 'b'],
      ['-C', 'a'],
    ])
  })
})

const Name = Schema.Struct({
  owner: Schema.Literals(['acme', 'eliraz-refael', 'a1']),
  repo: Schema.Literals(['widgets', 'path-of-dev', 'x.y_z']),
  alias: Schema.Literals(['private', 'work', 'gh-2', 'github.com']),
  user: Schema.Literals(['git@', 'ada@', '']),
  form: Schema.Literals(['scp', 'ssh', 'ssh-port']),
  suffix: Schema.Literals(['.git', '', '/', '.git\n']),
})

describe('a remote through an ssh alias', () => {
  prop.prop('names the GitHub repo once its alias resolves to github.com, and none before', [Name], ([drawn]) => {
    const path = `${drawn.owner}/${drawn.repo}${drawn.suffix}`
    const remote =
      drawn.form === 'scp'
        ? `${drawn.user}${drawn.alias}:${path}`
        : `ssh://${drawn.user}${drawn.alias}${drawn.form === 'ssh-port' ? ':2222' : ''}/${path}`
    const name = `${drawn.owner}/${drawn.repo}`
    if (drawn.alias === 'github.com') {
      expect(sshAliasOf(remote)).toBeNull()
      return
    }
    expect(sshAliasOf(remote)).toBe(drawn.alias)
    expect(githubName(remote, drawn.alias)).toBe(name)
    expect(githubName(remote)).toBeNull()
    expect(githubName(remote, 'elsewhere')).toBeNull()
  })

  it('reads its host name from what ssh -G prints', () => {
    expect(hostNameOf('user git\nhostname github.com\nport 22\n')).toBe('github.com')
    expect(hostNameOf('hostname GitHub.com\n')).toBe('github.com')
    expect(hostNameOf('user git\nport 22\n')).toBeNull()
    expect(sshAliasOf('https://github.com/acme/widgets')).toBeNull()
    expect(sshAliasOf('git@-oProxyCommand=x:acme/widgets')).toBeNull()
    expect(sshAliasOf('/srv/git/widgets.git')).toBeNull()
  })

  prop.prop('keeps a resolved host a day', [between(0, 2 * sshHostMs)], ([age]) => {
    const hosts = { private: { host: 'github.com', at: 1_000_000 } }
    expect(keptHostOf(hosts, 'private', 1_000_000 + age)).toBe(age <= sshHostMs ? 'github.com' : undefined)
    expect(keptHostOf(hosts, 'work', 1_000_000 + age)).toBeUndefined()
  })
})
