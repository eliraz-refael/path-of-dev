import { test as kitTest } from 'claude-code/testing'
import type { TestRest } from 'claude-code/testing'

// The band as it always was, open at rest, for the tests that draw it so: each runs with the `band` option `full`
// unless it says otherwise. collapse.test.ts plays it `auto` and `line`.

export const test = (name: string, ...rest: TestRest) =>
  rest.length === 1
    ? kitTest(name, { options: { band: 'full' } }, rest[0])
    : kitTest(name, { ...rest[0], options: { band: 'full', ...rest[0].options } }, rest[1])
