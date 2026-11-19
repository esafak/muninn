import { describe, expect, test } from "bun:test"
import { mergeGlyphDisplay, pillStatusIcon, pillStatusTone } from "./pill-status"

describe("pillStatusIcon", () => {
  test("uses a distinct branch icon for merged PRs", () => {
    expect(pillStatusIcon("merged", "ready", undefined)).toBe("branch")
  })

  test("maps open pull request merge states to status icons when tone is consistent", () => {
    const cases = [
      ["ready", "circle-check"],
      ["pending", "circle-exclamation"],
      ["blocked", "circle-xmark"],
      ["conflict", "circle-xmark"],
    ] as const
    for (const [mergeState, icon] of cases)
      expect(pillStatusIcon("open", mergeState, "success")).toBe(icon)
  })

  test("adverse chain evidence overrides optimistic merge-state glyphs (open and draft)", () => {
    const cases = [
      ["open", "ready", "danger", "circle-xmark"],
      ["open", "ready", "warning", "circle-exclamation"],
      ["open", "pending", "danger", "circle-xmark"],
      ["open", "blocked", "warning", "circle-xmark"],
      ["open", "conflict", "warning", "circle-xmark"],
      ["draft", "ready", "danger", "circle-xmark"],
      ["draft", "ready", "warning", "circle-exclamation"],
      ["draft", "pending", "danger", "circle-xmark"],
      ["open", "ready", undefined, "circle-check"],
      ["draft", "ready", undefined, "circle-check"],
      ["open", undefined, undefined, "circle-exclamation"],
    ] as const
    for (const [state, mergeState, tone, icon] of cases)
      expect(pillStatusIcon(state, mergeState, tone)).toBe(icon)
  })

  test("unknown open merge state uses tone, never a provider fallback", () => {
    expect(pillStatusIcon("open", null, "warning")).toBe("circle-exclamation")
    expect(pillStatusIcon("open", undefined, undefined)).toBe("circle-exclamation")
    expect(pillStatusIcon("open", null, "success")).toBe("circle-check")
    expect(pillStatusIcon("open", null, "danger")).toBe("circle-xmark")
    expect(pillStatusIcon("draft", undefined, undefined)).toBe("circle-exclamation")
  })

  test("closed and run-only pills are status circles, never a fallback", () => {
    expect(pillStatusIcon("draft", undefined, "danger")).toBe("circle-xmark")
    expect(pillStatusIcon("draft", "ready", undefined)).toBe("circle-check")
    expect(pillStatusIcon("closed", undefined, undefined)).toBe("circle-xmark")
    expect(pillStatusIcon(undefined, undefined, "success")).toBe("circle-check")
    expect(pillStatusIcon(undefined, undefined, undefined)).toBe("circle-exclamation")
  })
})

describe("mergeGlyphDisplay", () => {
  test("a danger tone never leaves an optimistic ready dot (changes requested, failed checks)", () => {
    expect(mergeGlyphDisplay("open", "ready", "danger")).toEqual({ state: "blocked", cross: true })
    expect(mergeGlyphDisplay("draft", "pending", "danger")).toEqual({ state: "blocked", cross: true })
    expect(mergeGlyphDisplay("open", "blocked", "danger")).toEqual({ state: "blocked", cross: true })
  })

  test("a warning tone downgrades ready to pending, without a cross", () => {
    expect(mergeGlyphDisplay("open", "ready", "warning")).toEqual({ state: "pending", cross: false })
    expect(mergeGlyphDisplay("draft", "ready", "warning")).toEqual({ state: "pending", cross: false })
  })

  test("without adverse tone the forge merge state shows through", () => {
    const cases = [
      ["ready", { state: "ready", cross: false }],
      ["pending", { state: "pending", cross: false }],
      ["blocked", { state: "blocked", cross: false }],
      ["conflict", { state: "conflict", cross: false }],
      [null, { state: "unknown", cross: false }],
      [undefined, { state: "unknown", cross: false }],
    ] as const
    for (const [mergeState, expected] of cases)
      expect(mergeGlyphDisplay("open", mergeState, undefined)).toEqual(expected)
  })

  test("merged PRs keep their merged glyph even under an adverse tone", () => {
    expect(mergeGlyphDisplay("merged", "ready", "danger")).toEqual({ state: "merged", cross: false })
    expect(mergeGlyphDisplay("merged", null, undefined)).toEqual({ state: "merged", cross: false })
  })
})

describe("pillStatusTone", () => {
  test("tints merged status success instead of leaving its branch glyph muted", () => {
    expect(pillStatusTone("merged", undefined)).toBe("success")
    expect(pillStatusTone("merged", "success")).toBe("success")
  })

  test("is total: every rendered pill gets a status tone", () => {
    expect(pillStatusTone("merged", "warning")).toBe("warning")
    expect(pillStatusTone("merged", "danger")).toBe("danger")
    expect(pillStatusTone("open", "success")).toBe("success")
    expect(pillStatusTone("open", undefined)).toBe("warning")
    expect(pillStatusTone("draft", undefined)).toBe("warning")
    expect(pillStatusTone("closed", undefined)).toBe("danger")
    expect(pillStatusTone(undefined, undefined)).toBe("warning")
    expect(pillStatusTone(undefined, "danger")).toBe("danger")
  })
})
