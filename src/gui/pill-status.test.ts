import { describe, expect, test } from "bun:test"
import { pillStatusIcon, pillStatusTone, aggregateStatusIcon } from "./pill-status"

describe("pillStatusIcon", () => {
  test("uses a distinct branch icon for merged PRs", () => {
    expect(pillStatusIcon("merged", "ready", undefined)).toBe("branch")
  })

  test("maps open pull request merge states to status icons", () => {
    const cases = [
      ["ready", "circle-check"],
      ["pending", "circle-exclamation"],
      ["blocked", "circle-xmark"],
      ["conflict", "circle-xmark"],
    ] as const
    for (const [mergeState, icon] of cases)
      expect(pillStatusIcon("open", mergeState, "danger")).toBe(icon)
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

describe("aggregateStatusIcon", () => {
  test("derives multi-pill shape from aggregate tone alone", () => {
    const cases = [
      ["danger", "circle-xmark"],
      ["warning", "circle-exclamation"],
      ["success", "circle-check"],
    ] as const
    for (const [tone, icon] of cases) expect(aggregateStatusIcon(tone)).toBe(icon)
  })
})
