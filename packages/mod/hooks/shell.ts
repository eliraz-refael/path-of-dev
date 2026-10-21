// A Bash command line as the mod reads it: the simple commands it runs and what joins each to the next. Not a shell,
// only enough of one to tell which programs a call runs. A word in quotes, a heredoc's body, a substitution and a
// comment are never commands of their own, so a commit message or an `echo` that names a runner runs none.

/** What follows a simple command: a list's `&&`, `||`, `;`, a new line or `&`, a pipe, or a subshell's bracket. */
export type Joint = '&&' | '||' | ';' | '\n' | '&' | '|' | '(' | ')'

/** One simple command: its words, quotes taken off, redirects left out, and the joint after it (null at the end). */
export type Simple = { words: ReadonlyArray<string>; then: Joint | null }

type Heredoc = { delimiter: string; isTabbed: boolean }

const blanks = new Set([' ', '\t'])
const breaks = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>'])
/** A redirect's operator, its descriptor before it: what it reads or writes is no word of the command either. */
const redirect = /^\d*(?:<<<|<<-|<<|<>|<&|>>|>&|>\||&>>|&>|<|>)/

/** The index past the `quote` that ends a string whose body starts at `from`, or the line's end with none. */
const pastQuote = (line: string, from: number, quote: string): number => {
  const at = line.indexOf(quote, from)
  return at === -1 ? line.length : at + 1
}

/** The index past the `close` that ends what `open` began at `from` (the index after `open`), nested ones counted. */
const closing = (line: string, from: number, open: string, close: string): number => {
  let depth = 1
  let i = from
  while (i < line.length) {
    const char = line[i]
    if (char === '\\') i += 2
    else if (char === "'") i = pastQuote(line, i + 1, "'")
    else if (char === '"') i = quoted(line, i + 1).end
    else if (char === '$' && line[i + 1] === '(') i = substitution(line, i + 2)
    else if (char === open) {
      depth += 1
      i += 1
    } else if (char === close) {
      depth -= 1
      i += 1
      if (depth === 0) return i
    } else i += 1
  }
  return line.length
}

/** The index past the `)` that ends a `$(` whose body starts at `from`: its quotes and heredocs are its own. */
const substitution = (line: string, from: number): number => scan(line, from, true).end

/** A double-quoted string whose body starts at `from`: its text, and the index past its closing quote. */
const quoted = (line: string, from: number): { text: string; end: number } => {
  let text = ''
  let i = from
  while (i < line.length && line[i] !== '"') {
    const char = line[i] ?? ''
    if (char === '\\' && i + 1 < line.length) {
      const next = line[i + 1] ?? ''
      text += '$`"\\\n'.includes(next) ? next : char + next
      i += 2
    } else if (char === '$' && line[i + 1] === '(') {
      const end = substitution(line, i + 2)
      text += line.slice(i, end)
      i = end
    } else if (char === '`') {
      const end = pastQuote(line, i + 1, '`')
      text += line.slice(i, end)
      i = end
    } else {
      text += char
      i += 1
    }
  }
  return { text, end: Math.min(line.length, i + 1) }
}

/** One word from `from`: its text with the quotes taken off, and the index past it. */
const word = (line: string, from: number): { text: string; end: number } => {
  let text = ''
  let i = from
  while (i < line.length && !breaks.has(line[i] ?? '')) {
    const char = line[i] ?? ''
    if (char === '\\') {
      if (line[i + 1] !== '\n') text += line[i + 1] ?? ''
      i += 2
    } else if (char === "'" || (char === '$' && line[i + 1] === "'")) {
      const from = char === "'" ? i + 1 : i + 2
      const end = pastQuote(line, from, "'")
      text += line.slice(from, line[end - 1] === "'" ? end - 1 : end)
      i = end
    } else if (char === '"') {
      const inner = quoted(line, i + 1)
      text += inner.text
      i = inner.end
    } else if (char === '$' && line[i + 1] === '(') {
      const end = substitution(line, i + 2)
      text += line.slice(i, end)
      i = end
    } else if (char === '$' && line[i + 1] === '{') {
      const end = closing(line, i + 2, '{', '}')
      text += line.slice(i, end)
      i = end
    } else if (char === '`') {
      const end = pastQuote(line, i + 1, '`')
      text += line.slice(i, end)
      i = end
    } else {
      text += char
      i += 1
    }
  }
  return { text, end: i }
}

/** The index of the line after the heredoc bodies that start at `from`, each up to its delimiter's own line. */
const pastBodies = (line: string, from: number, heredocs: ReadonlyArray<Heredoc>): number => {
  let i = from
  for (const heredoc of heredocs) {
    while (i < line.length) {
      const end = line.indexOf('\n', i)
      const row = line.slice(i, end === -1 ? line.length : end)
      i = end === -1 ? line.length : end + 1
      if ((heredoc.isTabbed ? row.replace(/^\t+/, '') : row) === heredoc.delimiter) break
    }
  }
  return i
}

/**
 * The simple commands from `from`, and where the scan stopped: the end of the line, or past the `)` that closes a
 * substitution when `isNested`.
 */
const scan = (line: string, from: number, isNested: boolean): { commands: Array<Simple>; end: number } => {
  const commands: Array<Simple> = []
  let words: Array<string> = []
  let heredocs: Array<Heredoc> = []
  let depth = 0
  let i = from
  // A joint with no words before it (a `(`, or what follows a `)`) joins the command before, in place of a bracket.
  const end = (then: Joint | null) => {
    const last = commands.at(-1)
    const isOpen = last !== undefined && (last.then === null || last.then === '(' || last.then === ')')
    if (words.length > 0) commands.push({ words, then })
    else if (then !== null && last !== undefined && isOpen) commands[commands.length - 1] = { ...last, then }
    words = []
  }
  while (i < line.length) {
    const char = line[i] ?? ''
    const two = line.slice(i, i + 2)
    if (blanks.has(char)) i += 1
    else if (char === '\\' && line[i + 1] === '\n') i += 2
    else if (char === '\n') {
      end('\n')
      i = pastBodies(line, i + 1, heredocs)
      heredocs = []
    } else if (char === '#') {
      const next = line.indexOf('\n', i)
      i = next === -1 ? line.length : next
    } else if (two === '&&' || two === '||') {
      end(two)
      i += 2
    } else if (two === '|&') {
      end('|')
      i += 2
    } else if (char === ';') {
      end(';')
      i += two === ';;' ? 2 : 1
    } else if (char === '|') {
      end('|')
      i += 1
    } else if (char === '&' && line[i + 1] !== '>') {
      end('&')
      i += 1
    } else if (char === '(') {
      depth += 1
      end('(')
      i += 1
    } else if (char === ')') {
      if (isNested && depth === 0) {
        end(null)
        return { commands, end: i + 1 }
      }
      depth -= 1
      end(')')
      i += 1
    } else if (redirect.test(line.slice(i))) {
      // A redirect: its operator and its target are no words of the command.
      const operator = redirect.exec(line.slice(i))?.[0] ?? char
      i += operator.length
      while (blanks.has(line[i] ?? '')) i += 1
      const target = word(line, i)
      i = target.end
      if (operator.endsWith('<<') || operator.endsWith('<<-')) {
        heredocs.push({ delimiter: target.text, isTabbed: operator.endsWith('-') })
      }
    } else {
      const next = word(line, i)
      words.push(next.text)
      i = next.end === i ? i + 1 : next.end
    }
  }
  end(null)
  return { commands, end: line.length }
}

/** The simple commands a Bash command line runs, in order, those inside substitutions left out. */
export const simpleCommands = (line: string): ReadonlyArray<Simple> => scan(line, 0, false).commands

/** A word that sets a variable for the command after it (`CI=1`). */
export const isAssignment = (word: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)

/** A program by its file's name, with no folder before it: `node_modules/.bin/vitest` is `vitest`. */
export const programOf = (word: string): string => word.slice(word.lastIndexOf('/') + 1)
