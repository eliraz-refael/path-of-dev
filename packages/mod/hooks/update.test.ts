import { describe, expect, test } from 'claude-code/testing'
import { compareVersions, isAnnounced, updateCommand, updateLine, updateOf, updateText } from './update'

// A newer mod, from plain values: semver's precedence, the update a session's answer tells of, and the words the band
// and the pane say it in. register.tsx wires them to the session, the store and the screen (pathofdev.test.ts).

describe('comparing versions', () => {
  test("ranks semver's own example in order", () => {
    const ranked = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.1',
      '1.1.0',
      '2.0.0',
    ]
    for (let i = 0; i + 1 < ranked.length; i++) {
      const [a, b] = [ranked[i] ?? '', ranked[i + 1] ?? '']
      expect({ a, b, by: compareVersions(a, b) }).toEqual({ a, b, by: -1 })
      expect({ a, b, by: compareVersions(b, a) }).toEqual({ a, b, by: 1 })
    }
  })

  test('reads each number as a number, not as text', () => {
    expect(compareVersions('0.10.0', '0.9.1')).toBe(1)
    expect(compareVersions('0.9.10', '0.9.9')).toBe(1)
    expect(compareVersions('10.0.0', '9.99.99')).toBe(1)
    expect(compareVersions('0.10.0', '0.10.0')).toBe(0)
    expect(compareVersions('0.10.0+build.1', '0.10.0')).toBe(0)
  })

  test('reads none of what is not a semantic version', () => {
    expect(compareVersions('0.10', '0.9.1')).toBeNull()
    expect(compareVersions('0.10.0', 'latest')).toBeNull()
  })
})

describe('the update a session tells of', () => {
  test('is the latest version, when it is newer than the mod', () => {
    expect(updateOf('0.9.1', '0.10.0', '0.0.0')).toEqual({ from: '0.9.1', to: '0.10.0', needs: null })
  })

  test('is none when the mod is at the latest version, or past it', () => {
    expect(updateOf('0.10.0', '0.10.0', '0.0.0')).toBeNull()
    expect(updateOf('0.10.0', '0.9.1', '0.0.0')).toBeNull()
    expect(updateOf('0.10.0', '0.10.0-rc.1', '0.0.0')).toBeNull()
  })

  test('is none when the server names no latest version, as a local one does, or one it cannot read', () => {
    expect(updateOf('0.9.1', undefined, '0.0.0')).toBeNull()
    expect(updateOf('0.9.1', 'soon', undefined)).toBeNull()
    expect(updateOf('0.9.1', 10, null)).toBeNull()
  })

  test("says the server needs it when the mod is under the server's oldest", () => {
    expect(updateOf('0.9.1', '0.10.0', '0.10.0')).toEqual({ from: '0.9.1', to: '0.10.0', needs: '0.10.0' })
    expect(updateOf('0.9.1', '0.11.0', '0.10.0')).toEqual({ from: '0.9.1', to: '0.11.0', needs: '0.10.0' })
    // An oldest past the latest it names: the mod updates to what the server needs.
    expect(updateOf('0.9.1', undefined, '0.10.0')).toEqual({ from: '0.9.1', to: '0.10.0', needs: '0.10.0' })
  })
})

describe('the words of an update', () => {
  const available = { from: '0.9.1', to: '0.10.0', needs: null }
  const needed = { from: '0.9.1', to: '0.10.0', needs: '0.10.0' }

  test('name the plugin by its marketplace, as Claude Code updates it', () => {
    expect(updateCommand).toBe('claude plugin update pathofdev@path-of-dev')
  })

  test("are the band's one line", () => {
    expect(updateLine(available)).toBe('Update available: 0.9.1 → 0.10.0 · claude plugin update pathofdev@path-of-dev')
    expect(updateLine(needed)).toBe('Update needed: 0.9.1 → 0.10.0 · claude plugin update pathofdev@path-of-dev')
  })

  test("are the pane's line, in full", () => {
    expect(updateText(available)).toBe(
      'Update available: 0.9.1 → 0.10.0 · run claude plugin update pathofdev@path-of-dev in a shell, then restart ' +
        'Claude Code',
    )
    expect(updateText(needed)).toBe(
      'Update needed: 0.9.1 → 0.10.0: the server needs 0.10.0 or later · run claude plugin update ' +
        'pathofdev@path-of-dev in a shell, then restart Claude Code',
    )
  })

  test('go on the band once a version, and every session for one the server needs', () => {
    expect(isAnnounced(available, undefined)).toBe(true)
    expect(isAnnounced(available, '0.9.5')).toBe(true)
    expect(isAnnounced(available, '0.10.0')).toBe(false)
    expect(isAnnounced(needed, '0.10.0')).toBe(true)
  })
})
