import { describe, expect, test } from "bun:test"
import { refreshKeyFor, shouldClearActiveRefresh, shouldRunAutoRefresh } from "./refresh-guard"

describe("refreshKeyFor", () => {
  test("keys a refresh by session plus directory", () => {
    expect(refreshKeyFor("ses_1", "/work/a")).toBe("ses_1\n/work/a")
    expect(refreshKeyFor("ses_1", "/work/b")).not.toBe(refreshKeyFor("ses_1", "/work/a"))
    expect(refreshKeyFor("ses_2", "/work/a")).not.toBe(refreshKeyFor("ses_1", "/work/a"))
  })
})

describe("shouldRunAutoRefresh", () => {
  test("runs when idle, skips a second poll while the first is still pending", () => {
    const key = refreshKeyFor("ses_1", "/work/a")
    expect(shouldRunAutoRefresh(undefined, key)).toBe(true)
    // Second poll one interval later, first still pending (repo discovery > POLL_MS).
    expect(shouldRunAutoRefresh(key, key)).toBe(false)
  })

  test("a session change supersedes instead of coalescing", () => {
    const first = refreshKeyFor("ses_1", "/work/a")
    const next = refreshKeyFor("ses_2", "/work/a")
    expect(shouldRunAutoRefresh(first, next)).toBe(true)
  })
})

describe("shouldClearActiveRefresh", () => {
  test("only the latest refresh for its key clears the marker", () => {
    const key = refreshKeyFor("ses_1", "/work/a")
    expect(shouldClearActiveRefresh(key, 3, key, 3)).toBe(true)
    // Superseded attempt leaves the newer owner's marker alone.
    expect(shouldClearActiveRefresh(key, 4, key, 3)).toBe(false)
    expect(shouldClearActiveRefresh(refreshKeyFor("ses_2", "/work/a"), 3, key, 3)).toBe(false)
  })
})
