import { describe, expect, test } from "bun:test"
import { pillStatusIcon } from "./pill-status"

describe("pillStatusIcon", () => {
  const fallback = "github"

  test("uses a distinct branch icon for merged PRs", () => {
    expect(pillStatusIcon("merged", "ready", undefined, fallback)).toBe("branch")
  })

  test("maps open pull request merge states to status icons", () => {
    const cases = [
      ["ready", "circle-check"],
      ["pending", "circle-exclamation"],
      ["blocked", "circle-xmark"],
      ["conflict", "circle-xmark"],
    ] as const
    for (const [mergeState, icon] of cases)
      expect(pillStatusIcon("open", mergeState, "danger", fallback)).toBe(icon)
  })

  test("falls back to chain tone for unknown open merge state", () => {
    expect(pillStatusIcon("open", null, "warning", fallback)).toBe("circle-exclamation")
    expect(pillStatusIcon("open", undefined, undefined, fallback)).toBe(fallback)
  })

  test("preserves tone and provider fallback for draft, closed, and run-only pills", () => {
    expect(pillStatusIcon("draft", undefined, "danger", fallback)).toBe("circle-xmark")
    expect(pillStatusIcon("closed", undefined, undefined, fallback)).toBe(fallback)
    expect(pillStatusIcon(undefined, undefined, "success", fallback)).toBe("circle-check")
    expect(pillStatusIcon(undefined, undefined, undefined, fallback)).toBe(fallback)
  })
})
