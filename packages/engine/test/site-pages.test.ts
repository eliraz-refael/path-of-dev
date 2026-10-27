import { defaultShown, profileSections } from "@pathofdev/schema"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { starterQuestPack, starterRules as rules, xpForLevel } from "../src/index.ts"

// The site's pages are static HTML in site/, served as they are by the static app at pathof.dev (nginx: a path is the
// file, or its folder's index.html; /u/* goes to the public server instead). No build step makes them, so these tests
// hold them together: every page is there and reachable from the nav, shares the one header and footer, has its own
// title, description and preview card, and every link inside the site lands on a page and an id that exist. The
// numbers the manual states are marked where they stand and read back against the rules:
//
//   data-rule="loot/pity/rareAfter"  the rules' value at that path; data-as="pct" as a percent, "tenth" over 10
//   data-rule="mod:minWords"         the mod's setting's default, from its manifest
//   data-level="10"                  the XP that level takes        data-weight="rare"   a rarity's base odds, in %
//   data-title="Adept"               the level the title starts at   data-count="species" how many the rules have
//
// The pages' CSP allows no inline style, the style sheet and fonts, and on the home page its one script by hash; the
// style sheet's link carries a hash of it, so Cloudflare never serves a page an old copy. After an edit to site.css or
// the home page's script, `pnpm site` writes both hashes.

const siteDir = new URL("../../../site/", import.meta.url)
const read = (path: string): string => readFileSync(new URL(path, siteDir), "utf8")

/** Each page, by the path it is served at, and its file. */
const pages: ReadonlyArray<{ readonly path: string; readonly file: string }> = [
  { path: "/", file: "index.html" },
  { path: "/start/", file: "start/index.html" },
  { path: "/play/", file: "play/index.html" },
  { path: "/commands/", file: "commands/index.html" },
  { path: "/privacy/", file: "privacy/index.html" },
  { path: "/faq/", file: "faq/index.html" },
  { path: "/changelog/", file: "changelog/index.html" },
]

const origin = "https://pathof.dev"
const sha256 = (text: string | Buffer) => createHash("sha256").update(text)
const cssVersion = sha256(read("site.css")).digest("hex").slice(0, 12)
const scriptOf = (page: string): string | undefined => /<script>([\s\S]*?)<\/script>/.exec(page)?.[1]
const scriptHash = (script: string): string => sha256(script).digest("base64")

/** The CSP a page sets: the style sheet and fonts, and its one inline script by hash, if it has one. */
const cspFor = (page: string): string => {
  const script = scriptOf(page)
  const base =
    "default-src 'none'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
    "img-src 'self' data:; base-uri 'none'; form-action 'none'"
  return script === undefined ? base : `${base}; script-src 'sha256-${scriptHash(script)}'`
}

// `pnpm site` stamps the hashes into the pages before the tests read them.
if (process.env["PATHOFDEV_WRITE_SITE"] === "1") {
  for (const { file } of pages) {
    const page = read(file)
    const stamped = page
      .replace(/\/site\.css\?v=[^"]*/g, `/site.css?v=${cssVersion}`)
      .replace(/(<meta http-equiv="Content-Security-Policy" content=")[^"]*/, (_, head: string) => `${head}${cspFor(page)}`)
    if (stamped !== page) writeFileSync(new URL(file, siteDir), stamped)
  }
}

const html = Object.fromEntries(pages.map(({ file }) => [file, read(file)]))
const manifest = JSON.parse(read("../packages/mod/.claude-plugin/plugin.json")) as {
  readonly version: string
  readonly userConfig: Readonly<Record<string, { readonly default: unknown }>>
}

const all = (text: string, pattern: RegExp): ReadonlyArray<RegExpMatchArray> => [...text.matchAll(pattern)]
const attr = (tag: string, name: string): string | undefined => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]
const meta = (page: string, key: string): ReadonlyArray<string> =>
  all(page, /<meta\s[^>]*>/g)
    .map(([tag]) => tag)
    .filter((tag) => attr(tag, "name") === key || attr(tag, "property") === key)
    .map((tag) => attr(tag, "content") ?? "")
const text = (markup: string): string =>
  markup
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim()
const block = (page: string, pattern: RegExp): string => {
  const found = pattern.exec(page)
  expect(found, String(pattern)).not.toBeNull()
  return found![0]
}
const ids = (page: string): ReadonlyArray<string> => all(page, /\sid="([^"]+)"/g).map(([, id]) => id!)

/** Whether `file` is a file in site/: a folder is never served as `$uri`. */
const isFile = (file: string): boolean => {
  const url = new URL(file, siteDir)
  return existsSync(url) && statSync(url).isFile()
}

/** The file nginx serves for a path on the site, as `try_files $uri $uri/index.html`, or null for a 404. */
const served = (path: string): string | null => {
  const relative = decodeURIComponent(path).replace(/^\//, "")
  const folder = relative === "" || relative.endsWith("/") ? relative : `${relative}/`
  return [relative, `${folder}index.html`].find(isFile) ?? null
}

describe("the site's pages", () => {
  it("are each served at their path", () => {
    for (const { path, file } of pages) expect(served(path), path).toBe(file)
  })

  it.each(pages)("$path has its own title, description, canonical address and preview card", ({ path, file }) => {
    const page = html[file]!
    const titles = all(page, /<title>([^<]+)<\/title>/g)
    expect(titles).toHaveLength(1)
    const title = text(titles[0]![1]!)
    expect(title).toMatch(/Path of Dev/)
    const [description] = meta(page, "description")
    expect(description?.length ?? 0, "description").toBeGreaterThan(60)
    expect(description?.length ?? 0, "description").toBeLessThanOrEqual(300)
    expect(all(page, /<link rel="canonical" href="([^"]+)">/g).map(([, href]) => href)).toEqual([`${origin}${path}`])
    expect(meta(page, "og:url")).toEqual([`${origin}${path}`])
    expect(meta(page, "og:title").map(text)).toEqual([title])
    expect(meta(page, "og:description")).toHaveLength(1)
    expect(meta(page, "og:image")).toEqual([`${origin}/og.png`])
    expect(meta(page, "og:image:alt")).toHaveLength(1)
    expect(meta(page, "twitter:card")).toEqual(["summary_large_image"])
    expect(/^<!doctype html>\n<html lang="en">/.test(page)).toBe(true)
  })

  it("have titles no two pages share", () => {
    const titles = pages.map(({ file }) => /<title>([^<]+)<\/title>/.exec(html[file]!)?.[1])
    expect(new Set(titles).size).toBe(pages.length)
  })

  it("preview as one 1200 by 630 PNG", () => {
    const png = readFileSync(new URL("og.png", siteDir))
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG")
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630])
    for (const { file } of pages) {
      expect(meta(html[file]!, "og:image:width"), file).toEqual(["1200"])
      expect(meta(html[file]!, "og:image:height"), file).toEqual(["630"])
    }
  })
})

describe("the site's security", () => {
  it.each(pages)("$path sets its CSP first, allowing its own script alone", ({ file }) => {
    const page = html[file]!
    expect(page).toContain(`<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${cspFor(page)}">`)
    expect(all(page, /<script/g).length).toBe(file === "index.html" ? 1 : 0)
    expect(page).not.toMatch(/\sstyle="/)
    expect(page).not.toMatch(/<style/)
    expect(page).not.toMatch(/\son[a-z]+="/)
    expect(page).not.toMatch(/javascript:/)
  })

  it.each(pages)("$path links the style sheet by its current hash", ({ file }) => {
    const sheets = all(html[file]!, /<link rel="stylesheet" href="([^"]+)">/g).map(([, href]) => href)
    expect(sheets).toEqual([expect.stringMatching(/^https:\/\/fonts\.googleapis\.com\/css2\?/), `/site.css?v=${cssVersion}`])
  })
})

describe("the site's header and footer", () => {
  const nav = [
    ["/start/", "Get started"],
    ["/play/", "How it plays"],
    ["/commands/", "Commands"],
    ["/privacy/", "Privacy"],
    ["/faq/", "FAQ"],
  ] as const
  const headerOf = (path: string) =>
    `<header class="nav">
    <a class="brand" href="/"><span class="brand-mark" aria-hidden="true">⚔</span> Path of Dev</a>
    <nav aria-label="Site">
      <ul class="nav-links">
${nav.map(([href, label]) => `        <li><a class="nav-link" href="${href}"${href === path ? ' aria-current="page"' : ""}>${label}</a></li>`).join("\n")}
        <li><span class="pill">Open beta</span></li>
      </ul>
    </nav>
  </header>`

  it.each(pages)("$path has the one header, its own link marked", ({ path, file }) => {
    expect(block(html[file]!, /<header class="nav">[\s\S]*?<\/header>/)).toBe(headerOf(path))
  })

  it("links every page but the home page and the changelog from the header, and those from the footer", () => {
    const linked = new Set([...nav.map(([href]) => href), "/"])
    const footer = block(html["index.html"]!, /<footer class="foot">[\s\S]*?<\/footer>/)
    for (const [, href] of all(footer, /href="(\/[^"#]*)"/g)) linked.add(href!)
    expect([...linked].sort()).toEqual(pages.map(({ path }) => path).sort())
  })

  it.each(pages)("$path has the one footer", ({ file }) => {
    const footer = (page: string) => block(page, /<footer class="foot">[\s\S]*?<\/footer>/)
    expect(footer(html[file]!)).toBe(footer(html["index.html"]!))
  })
})

describe("the site's structure", () => {
  // The pages share one style sheet but not their ids: a rule on #pet, meant for the home page's canvas, once shrank
  // the Pet section of /play/ and /commands/ to the canvas's 70 by 60 pixels. So the sheet never selects by id,
  // whether as #id or as [id].
  it("never styles by an id, which a page may also use", () => {
    const css = read("site.css").replace(/\/\*[\s\S]*?\*\//g, "")
    const selectors = all(css, /([^{}]+)\{/g).map(([, selector]) => selector!.trim())
    expect(selectors.length).toBeGreaterThan(100)
    expect(selectors.filter((selector) => /#[A-Za-z_-]|\[\s*id\b/.test(selector))).toEqual([])
  })

  it.each(pages)("$path has one h1, headings that never skip a level, and ids it uses once", ({ file }) => {
    const page = html[file]!
    // The footer's own headings stand apart from the page's outline.
    const body = page.slice(0, page.indexOf('<footer class="foot">'))
    const levels = all(body, /<h([1-6])[\s>]/g).map(([, n]) => Number(n))
    expect(levels.filter((n) => n === 1)).toHaveLength(1)
    expect(levels[0]).toBe(1)
    levels.forEach((n, i) => {
      if (i > 0) expect(n - levels[i - 1]!, `h${levels[i - 1]} then h${n}`).toBeLessThanOrEqual(1)
    })
    const seen = ids(page)
    expect(seen.length).toBe(new Set(seen).size)
    expect(page).toContain('<a class="skip" href="#main">Skip to content</a>')
    expect(seen).toContain("main")
  })

  it.each(pages)("$path links only to pages and ids that are there, and off the site only over https", ({ path, file }) => {
    for (const [, href] of all(html[file]!, /\shref="([^"]+)"/g)) {
      if (href!.startsWith("https://fonts.") || href!.startsWith("data:")) continue
      if (/^https?:\/\//.test(href!)) {
        expect(href, href).toMatch(/^https:\/\//)
        continue
      }
      const [target, fragment] = href!.split("#") as [string, string | undefined]
      const into = target === "" ? file : served(target.split("?")[0]!)
      expect(into, `${path} links ${href}`).not.toBeNull()
      if (fragment !== undefined && into!.endsWith(".html")) {
        expect(ids(html[into!] ?? read(into!)), `${path} links ${href}`).toContain(fragment)
      }
    }
  })

  it.each(pages)("$path gives each table of contents entry a section", ({ file }) => {
    const page = html[file]!
    const toc = /<nav class="toc"[\s\S]*?<\/nav>/.exec(page)?.[0]
    if (toc === undefined) return
    for (const [, id] of all(toc, /href="#([^"]+)"/g)) expect(page).toContain(`<section id="${id}"`)
  })
})

/** The value at `path` in `root`, by keys and indexes split on `/`. */
const at = (root: unknown, path: string): unknown =>
  path.split("/").reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], root)

const fmt = (n: number): string => n.toLocaleString("en-US", { maximumFractionDigits: 3 })
const total = Object.values(rules.loot.weights).reduce((a, b) => a + b, 0)

describe("the numbers the site states", () => {
  const marked = pages.flatMap(({ file }) =>
    all(html[file]!, /<(\w+)\s([^>]*data-(rule|level|weight|title|count)="[^"]*"[^>]*)>([\s\S]*?)<\/\1>/g).map(
      ([, , attrs, kind, inner]) => ({ file, kind: kind!, attrs: ` ${attrs!}`, shown: text(inner!) }),
    )
  )

  it("marks some", () => {
    expect(marked.length).toBeGreaterThan(50)
  })

  it.each(marked)("$file: $attrs reads as the rules have it", ({ kind, attrs, shown }) => {
    const key = attr(attrs, `data-${kind}`)!
    switch (kind) {
      case "rule": {
        if (key.startsWith("mod:")) {
          expect(shown).toBe(String(manifest.userConfig[key.slice(4)]?.default))
          return
        }
        const value = at(rules, key)
        expect(typeof value, key).toBe("number")
        const as = attr(attrs, "data-as")
        const n = as === "pct" ? (value as number) * 100 : as === "tenth" ? (value as number) / 10 : (value as number)
        expect(shown).toBe(fmt(Math.round(n * 1000) / 1000))
        return
      }
      case "level":
        return expect(shown).toBe(fmt(xpForLevel(rules.levelCurve, Number(key))))
      case "weight":
        return expect(shown).toBe(String(Math.round((rules.loot.weights[key as keyof typeof rules.loot.weights] / total) * 1000) / 10))
      case "title":
        return expect(shown).toBe(String(rules.titles.find((title) => title.title === key)?.fromLevel))
      case "count": {
        const counted = key === "species" ? rules.pet.species : key === "achievements" ? rules.achievements : null
        expect(counted, key).not.toBeNull()
        return expect(shown).toBe(String(counted!.length))
      }
    }
  })

  it("names the titles in the rules' order, and only theirs", () => {
    const named = all(html["play/index.html"]!, /data-title="([^"]+)"/g).map(([, name]) => name)
    expect(named).toEqual(rules.titles.map((title) => title.title))
  })

  it("names only missions the starter pack has, with their cadence", () => {
    const named = all(html["play/index.html"]!, /<li data-quest="([^"]+)"><b>[^<]+<\/b> \((daily|weekly)\)/g)
    expect(named.length).toBeGreaterThan(0)
    for (const [, title, cadence] of named) {
      expect(starterQuestPack.quests.find((quest) => quest.title === title)?.cadence, title).toBe(cadence)
    }
  })

  it("draws the home page's odds bar in the rules' proportions", () => {
    const css = read("site.css")
    for (const [rarity, weight] of Object.entries(rules.loot.weights)) {
      expect(css).toContain(`.odds .${rarity} { flex: ${weight}; background: var(--${rarity}); }`)
    }
  })

  it("says the home page's GitHub-checked rows are still coming, as the rules don't pay them yet", () => {
    const rows = all(html["index.html"]!, /<tr class="soon"><td class="what">([^<]+) <span class="gh">GitHub<\/span><small>coming: once GitHub checks it<\/small>/g)
    const verified = Object.entries(rules.xp).filter(([, rule]) => rule.tier === "verified")
    expect(rows).toHaveLength(verified.length)
    expect(all(html["index.html"]!, /<span class="gh">GitHub<\/span>/g)).toHaveLength(verified.length)
  })
})

describe("the privacy page", () => {
  const page = html["privacy/index.html"]!
  const privacy = read("../docs/privacy.md")

  it("lists the profile's sections, and the one that starts hidden, as the schema does", () => {
    const rows = all(page, /<tr data-section="([a-z]+)">[\s\S]*?<td>(shown|hidden)<\/td><\/tr>/g)
    expect(rows.map(([, section]) => section)).toEqual([...profileSections])
    for (const [, section, start] of rows) {
      expect(start, section).toBe(defaultShown[section as keyof typeof defaultShown] ? "shown" : "hidden")
      expect(privacy, section).toContain(`| \`${section}\` |`)
    }
  })

  it("names the sections on the commands page as the schema does", () => {
    const [, listed] = /<span data-sections>([\s\S]*?)<\/span>/.exec(html["commands/index.html"]!) ?? []
    expect(all(listed ?? "", /<code>([a-z]+)<\/code>/g).map(([, section]) => section)).toEqual([...profileSections])
  })

  it("states what the privacy notice says of backups", () => {
    for (const [, claim] of all(page, /data-privacy="([^"]+)"/g)) expect(privacy).toContain(claim)
  })

  it("links the full notice", () => {
    expect(page).toContain('href="https://github.com/eliraz-refael/path-of-dev/blob/main/docs/privacy.md"')
  })
})

describe("the changelog", () => {
  const versions = all(html["changelog/index.html"]!, /data-version="([^"]+)"/g).map(([, version]) => version!)
  const parts = (version: string) => version.split(".").map(Number)

  it("starts at the mod's version, as its manifest names it", () => {
    expect(versions[0]).toBe(manifest.version)
  })

  it("goes newest first, each version once", () => {
    for (let i = 1; i < versions.length; i++) {
      const [a, b] = [parts(versions[i - 1]!), parts(versions[i]!)]
      expect(a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!, `${versions[i - 1]} before ${versions[i]}`).toBeGreaterThan(0)
    }
  })
})
