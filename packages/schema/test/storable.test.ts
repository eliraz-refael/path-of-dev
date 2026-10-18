import { it } from "@effect/vitest"
import { Exit, Schema } from "effect"
import { describe, expect } from "vitest"
import { ClientEvent, Command, isStorable } from "../src/index.ts"

// What jsonb can hold, as properties: a string exactly when it has no NUL and survives UTF-8 (which no lone surrogate
// does), a value exactly when every string in it does, keys too; and a command or an event holding one it can't is
// malformed, so the edge turns it away before a write fails on it.

/** Pieces of a string, drawn often from what jsonb refuses and from what it takes that comes close: a whole pair. */
const Piece = Schema.Union([
  Schema.Literals(["\u0000", "\ud83d", "\ude00", "😀", "a", "é"]),
  Schema.String.check(Schema.isMaxLength(16)),
])
const Text = Schema.Array(Piece).check(Schema.isMaxLength(6))
const text = (pieces: ReadonlyArray<string>): string => pieces.join("")

/** UTF-8 can't carry a lone surrogate, so a string that comes back the same has none. */
const survivesUtf8 = (value: string): boolean => new TextDecoder().decode(new TextEncoder().encode(value)) === value

const ulid = "01K6ZQ8W3J5V7XKQ2M4N6P8R9T"

describe("isStorable", () => {
  it.prop("takes a string exactly when it has no NUL and survives UTF-8", [Text], ([pieces]) => {
    const value = text(pieces)
    expect(isStorable(value)).toBe(!value.includes("\u0000") && survivesUtf8(value))
  })

  it.prop("takes a value exactly when it takes every string in it, keys too", [Text, Text, Text], ([a, b, c]) => {
    const [x, y, z] = [text(a), text(b), text(c)]
    const every = isStorable(x) && isStorable(y) && isStorable(z)
    expect(isStorable([x, { [y]: [z] }])).toBe(every)
    expect(isStorable({ [x]: { kept: y }, list: [1, null, true, z] })).toBe(every)
  })
})

describe("a command or an event holding a string", () => {
  it.prop("decodes exactly when jsonb can hold the string", [Text], ([pieces]) => {
    const value = text(pieces)
    const command = { id: ulid, type: "egg.choose", data: { species: "fox", name: value } }
    const event = { id: ulid, type: "tests.passed", occurredAt: "2026-10-08T12:00:00Z", sessionId: ulid, data: { checkout: null, runner: value } }
    expect(Exit.isSuccess(Schema.decodeUnknownExit(Command)(command))).toBe(isStorable(value))
    expect(Exit.isSuccess(Schema.decodeUnknownExit(ClientEvent)(event))).toBe(isStorable(value))
  })
})
