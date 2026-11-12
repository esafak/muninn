import { describe, expect, test } from "bun:test"
import { defaultModelFor, parseOpenAICompatibleModelList, validateModelSyntax } from "./model-id"

describe("validateModelSyntax", () => {
  test("accepts bare slugs, namespaced IDs, and one variant suffix", () => {
    expect(validateModelSyntax("jev-1.13")).toEqual({ ok: true })
    expect(validateModelSyntax("typesafe/jev-1.13")).toEqual({ ok: true })
    expect(validateModelSyntax("gpt-6-luna-decision")).toEqual({ ok: true })
    expect(validateModelSyntax("openai/gpt-6-luna-decisions")).toEqual({ ok: true })
    expect(validateModelSyntax("  jev-1.13  ")).toEqual({ ok: true })
    expect(validateModelSyntax("model:free")).toEqual({ ok: true })
  })

  test("rejects empty, long, spaced, URL-like, and malformed IDs", () => {
    expect(validateModelSyntax("")).toEqual({ ok: false, reason: "empty: leave blank to use the provider default" })
    expect(validateModelSyntax("   ")).toEqual({ ok: false, reason: "empty: leave blank to use the provider default" })
    expect(validateModelSyntax("a".repeat(129))).toEqual({ ok: false, reason: "too long: 129 characters (max 128)" })
    expect(validateModelSyntax("a".repeat(128))).toEqual({ ok: true })
    expect(validateModelSyntax("jev 1.13")).toEqual({ ok: false, reason: "must not contain spaces" })
    expect(validateModelSyntax("https://example.com/model")).toEqual({
      ok: false,
      reason: "looks like a URL: enter the model ID, not an endpoint",
    })
    expect(validateModelSyntax("typesafe//jev-1.13")).toEqual({ ok: false, reason: "must not contain //" })
    expect(validateModelSyntax("/jev-1.13")).toEqual({
      ok: false,
      reason: "use letters, numbers, dot, dash, underscore, slash (e.g. jev-1.13, typesafe/jev-1.13)",
    })
    expect(validateModelSyntax("jev-1.13/")).toEqual({
      ok: false,
      reason: "use letters, numbers, dot, dash, underscore, slash (e.g. jev-1.13, typesafe/jev-1.13)",
    })
    expect(validateModelSyntax("model:free:extra")).toEqual({
      ok: false,
      reason: "at most one :variant suffix (e.g. model:free)",
    })
    expect(validateModelSyntax("model:")).toEqual({ ok: false, reason: "at most one :variant suffix (e.g. model:free)" })
  })
})

describe("defaultModelFor", () => {
  test("returns each backend's pinned default", () => {
    expect(defaultModelFor("zen")).toBe("jev-1.13")
    expect(defaultModelFor("openrouter")).toBe("typesafe/jev-1.13")
    expect(defaultModelFor("openai")).toBe("gpt-6-luna-decision")
  })
})

describe("parseOpenAICompatibleModelList", () => {
  test("extracts trimmed IDs and skips unusable entries", () => {
    expect(parseOpenAICompatibleModelList({ object: "list", data: [{ id: "jev-1.13" }, { id: " gpt-6-luna-decision " }] })).toEqual([
      "jev-1.13",
      "gpt-6-luna-decision",
    ])
    expect(parseOpenAICompatibleModelList({ data: [{ id: 42 }, { name: "no-id" }, null, { id: "  " }] })).toEqual([])
  })

  test("returns empty for missing or malformed payloads", () => {
    expect(parseOpenAICompatibleModelList(undefined)).toEqual([])
    expect(parseOpenAICompatibleModelList(null)).toEqual([])
    expect(parseOpenAICompatibleModelList({ data: "nope" })).toEqual([])
    expect(parseOpenAICompatibleModelList({})).toEqual([])
  })
})
