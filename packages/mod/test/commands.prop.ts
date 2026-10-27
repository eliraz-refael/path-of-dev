import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import manifest from '../.claude-plugin/plugin.json'
import { dataAskOf, dataUsage } from '../hooks/account'
import { betaAskOf, betaUsage } from '../hooks/beta'
import { devAskOf, devUsage } from '../hooks/dev'
import { historyAskOf, historyUsage } from '../hooks/history'
import { accountAskOf, accountUsage } from '../hooks/login'
import { tabs } from '../hooks/pane'
import { petAskOf, petUsage } from '../hooks/pet-motion'
import { profileAskOf, profileUsage } from '../hooks/profile'
import { serverAskOf, serverUsage } from '../hooks/switching'

// The site's command reference (site/commands/index.html) against the mod's own commands, both ways: every command it
// documents is one the mod runs, and every command the mod runs is documented. The mod has no table of commands:
// `runCommandLine` (register.tsx) tries two words of its own, then each `…AskOf` parser in turn, and opens the pane
// for anything none of them claims. So these tests replay that chain, after checking it is still the one the source
// has, and probe it with every word the parsers and their usage lines know:
//
//   site/commands: data-command="/pathofdev profile hide <section>" data-example="profile hide stats"
//     └─▶ the example runs through the chain to an ask (not a usage line, not the pane), and fits its form
//   every word in the parsers' sources and usage lines ─▶ probes of one, two and three words
//     └─▶ each the chain takes as an ask fits a documented form (a <placeholder> is any one word)
//
// The settings (the manifest's userConfig) and the pane's tabs are documented there too, and checked the same way.

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')
const page = read('../../../site/commands/index.html')
const source = read('../hooks/register.tsx')

const unescaped = (text: string): string =>
  text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
const all = (text: string, pattern: RegExp): ReadonlyArray<RegExpMatchArray> => [...text.matchAll(pattern)]
const attrOf = (tag: string, name: string): string | undefined => {
  const found = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]
  return found === undefined ? undefined : unescaped(found)
}

/** What the chain makes of a line: one of its own words, a parser's ask or usage line, or the pane. */
type Outcome =
  | { readonly kind: 'word'; readonly word: string }
  | { readonly kind: 'ask'; readonly by: string }
  | { readonly kind: 'usage'; readonly by: string }
  | { readonly kind: 'pane' }

const parsers: Readonly<Record<string, (args: string) => unknown>> = {
  accountAskOf,
  betaAskOf,
  profileAskOf,
  petAskOf,
  historyAskOf,
  dataAskOf,
  serverAskOf,
  devAskOf,
}

const dispatcher = (() => {
  const start = source.indexOf('const runCommandLine = ')
  const end = source.indexOf('\n}\n', start)
  expect(start, 'runCommandLine in register.tsx').toBeGreaterThan(0)
  return source.slice(start, end)
})()
const words = all(dispatcher, /args\.trim\(\) === '([a-z]+)'/g).map(([, word]) => word!)
const chain = all(dispatcher, /\b(\w+AskOf)\(args\)/g).map(([, name]) => name!)

const outcomeOf = (args: string): Outcome => {
  const word = words.find((one) => args.trim() === one)
  if (word !== undefined) return { kind: 'word', word }
  for (const by of chain) {
    const asked = parsers[by]?.(args)
    if (asked === null || asked === undefined) continue
    return typeof asked === 'string' ? { kind: 'usage', by } : { kind: 'ask', by }
  }
  return { kind: 'pane' }
}
const runs = (outcome: Outcome): boolean => outcome.kind === 'word' || outcome.kind === 'ask'

/** Each command the page documents: its form, the other forms it names, and an example of its arguments. */
const documented = all(page, /<div class="cmd" data-command="[^"]*"[^>]*>/g).map(([tag]) => ({
  form: attrOf(tag, 'data-command')!,
  aliases: (attrOf(tag, 'data-aliases') ?? '').split(',').map((one) => one.trim()).filter((one) => one !== ''),
  example: attrOf(tag, 'data-example'),
}))
const forms = documented.flatMap(({ form, aliases }) => [form, ...aliases])
const argsOfForm = (form: string): string => form.replace(/^\/pathofdev\s*/, '')
const patternOf = (form: string): RegExp =>
  new RegExp(
    `^${argsOfForm(form)
      .split(/\s+/)
      .filter((word) => word !== '')
      .map((word) => (/^<.+>$/.test(word) ? '\\S+' : word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join(' ')}$`,
  )
const pathofdevForms = forms.filter((form) => form === '/pathofdev' || form.startsWith('/pathofdev '))
const fits = (args: string): boolean => pathofdevForms.some((form) => patternOf(form).test(args.trim().split(/\s+/).join(' ')))

describe('the command reference', () => {
  it('replays the chain register.tsx runs, word for word and parser for parser', () => {
    expect(words).toEqual(['welcome', 'last'])
    expect(chain).toEqual(Object.keys(parsers))
    expect(dispatcher).toContain('await openPane($)')
  })

  it('documents each slash command the mod registers, and only those', () => {
    const registered = all(source, /\.register\(\{\s*name: '([a-z]+)'/g).map(([, name]) => `/${name}`)
    expect(registered.length).toBeGreaterThan(0)
    const tops = new Set(forms.map((form) => form.split(' ')[0]))
    expect([...tops].sort()).toEqual([...new Set(registered)].sort())
  })

  it('documents some', () => {
    expect(pathofdevForms.length).toBeGreaterThan(30)
  })

  it.each(documented.filter(({ form }) => form.startsWith('/pathofdev')))(
    '$form runs as documented, by its example',
    ({ form, aliases, example }) => {
      expect(example, `${form} has a data-example`).toBeDefined()
      expect(patternOf(form).test(example!), `${example} fits ${form}`).toBe(true)
      if (form === '/pathofdev') expect(outcomeOf(example!)).toEqual({ kind: 'pane' })
      else expect(runs(outcomeOf(example!)), `/pathofdev ${example}`).toBe(true)
      for (const alias of aliases) {
        if (!alias.includes('<')) expect(runs(outcomeOf(argsOfForm(alias))), alias).toBe(true)
      }
    },
  )

  it('documents every command the mod runs', () => {
    // Every word the parsers compare against, and every word of their usage lines and the command's description.
    const sources = ['account', 'beta', 'dev', 'history', 'login', 'pet-motion', 'profile', 'switching']
      .map((name) => read(`../hooks/${name}.ts`))
      .join('\n')
    const usages = [accountUsage, betaUsage, dataUsage, devUsage, historyUsage, petUsage, profileUsage, serverUsage]
    const description = /name: 'pathofdev',\s*description:([\s\S]*?)\}\)/.exec(source)?.[1] ?? ''
    const vocabulary = new Set([
      ...all(sources, /'([a-z][a-z-]{0,15})'/g).map(([, word]) => word!),
      ...[...usages, description, ...forms].flatMap((text) => text.match(/[a-z][a-z-]*/g) ?? []),
      ...words,
    ])
    const known = new Set([...usages, description, ...forms].flatMap((text) => text.match(/[a-z][a-z-]*/g) ?? []))
    const samples = ['1', '50', 'octocat', 'x']
    const heads = [...vocabulary].filter((word) => outcomeOf(word).kind !== 'pane')
    const probes = [
      ...vocabulary,
      ...heads.flatMap((head) => [...vocabulary, ...samples].map((sub) => `${head} ${sub}`)),
      ...heads.flatMap((head) =>
        [...known].flatMap((sub) => [...vocabulary, ...samples].map((third) => `${head} ${sub} ${third}`))
      ),
    ]
    const undocumented = probes.filter((probe) => runs(outcomeOf(probe)) && !fits(probe))
    expect(heads.length).toBeGreaterThan(5)
    expect(undocumented.slice(0, 10).map((probe) => `/pathofdev ${probe}`)).toEqual([])
  })

  it('documents every setting in the manifest, with its options and its default', () => {
    const settings = all(page, /<div class="cmd" data-setting="[^"]*"[^>]*>/g).map(([tag]) => ({
      key: attrOf(tag, 'data-setting')!,
      options: attrOf(tag, 'data-options'),
      default: attrOf(tag, 'data-default'),
    }))
    const config = manifest.userConfig as Record<string, { type: string; options?: ReadonlyArray<string>; default: unknown }>
    expect(settings.map(({ key }) => key).sort()).toEqual(Object.keys(config).sort())
    for (const setting of settings) {
      const option = config[setting.key]!
      const options = option.type === 'boolean' ? ['true', 'false'] : option.options
      expect(setting.options?.split(' '), setting.key).toEqual(options)
      expect(setting.default, setting.key).toBe(String(option.default))
    }
  })

  it('lists the pane\'s tabs in their order, there and on Get started', () => {
    const ids = tabs.map((tab) => tab.id)
    for (const where of ['../../../site/commands/index.html', '../../../site/start/index.html']) {
      expect(all(read(where), /data-tab="([a-z]+)"/g).map(([, id]) => id), where).toEqual(ids)
    }
  })
})
