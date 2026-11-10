import { describe, expect, test } from "bun:test"
import { baseCheckoutDecision, cleanupDecision, cleanupResultMessage, cleanupSessionMatches, fastForwardDecision, safeFastForward, sessionMoveConfirmed, shouldFastForwardBase, shouldRecordCleanupFailure, worktreeOccupancyDecision } from "./local-cleanup"

describe("cleanupSessionMatches", () => {
  test("does not redirect an in-flight merge cleanup after switching sessions", () => {
    expect(cleanupSessionMatches("session-a", "session-b")).toBe(false)
    expect(cleanupSessionMatches("session-a", "session-a")).toBe(true)
  })
})

describe("baseCheckoutDecision", () => {
  test("moves only to a distinct, clean checkout on the PR base branch", () => {
    const ready = { differentTree: true, onBaseBranch: true, clean: true }
    expect(baseCheckoutDecision(ready)).toEqual({ move: true })
    expect(baseCheckoutDecision({ ...ready, differentTree: false }).move).toBe(false)
    expect(baseCheckoutDecision({ ...ready, onBaseBranch: false }).move).toBe(false)
    expect(baseCheckoutDecision({ ...ready, clean: false }).move).toBe(false)
  })
})

describe("sessionMoveConfirmed", () => {
  test("does not permit removal on an acknowledged but still-pending session move", () => {
    expect(sessionMoveConfirmed("/worktrees/feature", "/repo")).toBe(false)
    expect(sessionMoveConfirmed(undefined, "/repo")).toBe(false)
    expect(sessionMoveConfirmed("/repo", "/repo")).toBe(true)
  })
})

describe("worktreeOccupancyDecision", () => {
  test("moves only the origin session when it is the sole exact or nested occupant", () => {
    expect(worktreeOccupancyDecision([{ id: "origin", directory: "/tree" }], "origin", "/tree", false)).toEqual({ safe: true })
    expect(worktreeOccupancyDecision([{ id: "origin", directory: "/tree/sub" }], "origin", "/tree", false)).toEqual({ safe: true })
  })

  test("keeps an idle child origin visible to the sole-occupant check", () => {
    const origin = {
      id: "origin",
      parentID: "parent",
      outcome: "succeeded" as const,
      time: { busy: 10, idle: 10 },
      directory: "/tree",
    }
    expect(worktreeOccupancyDecision([origin], "origin", "/tree", false)).toEqual({ safe: true })
    expect(worktreeOccupancyDecision([
      origin,
      { id: "other", directory: "/tree/child" },
    ], "origin", "/tree", false)).toEqual({
      safe: false,
      message: "another session uses the worktree; left it intact",
    })
  })

  test("ignores a child only when its last execution is terminal and idle", () => {
    const terminal = ["succeeded", "failed", "interrupted"] as const
    for (const outcome of terminal)
      expect(worktreeOccupancyDecision([
        { id: "origin", directory: "/tree" },
        {
          id: "finished-child",
          parentID: "origin",
          outcome,
          time: { busy: 10, idle: 10 },
          directory: "/tree/child",
        },
      ], "origin", "/tree", false)).toEqual({ safe: true })
  })

  test("keeps missing lifecycle data and active or independent sessions protective", () => {
    const child = { id: "child", parentID: "origin", directory: "/tree/child" }
    const cases = [
      { ...child, outcome: "succeeded" as const },
      { ...child, outcome: "succeeded" as const, time: { busy: 10 } },
      { ...child, outcome: "succeeded" as const, time: { idle: 10 } },
      { ...child, outcome: "succeeded" as const, time: { busy: 11, idle: 10 } },
      { ...child, time: { busy: 10, idle: 10, archived: 12 } },
      { id: "independent", directory: "/tree/child", outcome: "succeeded" as const, time: { busy: 10, idle: 10 } },
    ]
    for (const session of cases)
      expect(worktreeOccupancyDecision([session], "origin", "/tree", false)).toEqual({
        safe: false,
        message: "another session uses the worktree; left it intact",
      })
  })

  test("ignoring a finished child does not hide a different active child", () => {
    expect(worktreeOccupancyDecision([
      { id: "origin", directory: "/tree" },
      { id: "finished", parentID: "origin", outcome: "succeeded", time: { busy: 10, idle: 10 }, directory: "/tree/finished" },
      { id: "running", parentID: "origin", outcome: "succeeded", time: { busy: 12, idle: 10 }, directory: "/tree/running" },
    ], "origin", "/tree", false)).toEqual({
      safe: false,
      message: "another session uses the worktree; left it intact",
    })
  })

  test("after a confirmed move, ignores a stale origin entry but not another live occupant", () => {
    expect(worktreeOccupancyDecision([{ id: "origin", directory: "/tree" }], "origin", "/tree", true)).toEqual({ safe: true })
    expect(worktreeOccupancyDecision([
      { id: "origin", directory: "/tree" },
      { id: "other", directory: "/tree/child" },
    ], "origin", "/tree", true)).toEqual({
      safe: false,
      message: "another session still uses the old worktree; left it intact",
    })
    expect(worktreeOccupancyDecision([], "origin", "/tree", true)).toEqual({ safe: true })
  })

  test("a session found on a later page and a similarly prefixed sibling remain distinct", () => {
    const pages = [
      [{ id: "origin", directory: "/tree" }],
      [{ id: "sibling", directory: "/treehouse" }],
      [{ id: "nested", directory: "/tree/nested" }],
    ]
    expect(worktreeOccupancyDecision(pages.flat(), "origin", "/tree", false).safe).toBe(false)
    expect(worktreeOccupancyDecision([{ id: "origin", directory: "/tree" }, { id: "sibling", directory: "/treehouse" }], "origin", "/tree", false)).toEqual({ safe: true })
    expect(worktreeOccupancyDecision([], "origin", "/tree", false)).toEqual({
      safe: false,
      message: "origin session is not confirmed as the sole worktree user; left it intact",
    })
  })
})

describe("shouldRecordCleanupFailure", () => {
  test("records only a failed branch-deletion stage", () => {
    // Cleanup skipped or worktree removal rejected before the branch stage.
    expect(shouldRecordCleanupFailure(false, false)).toBe(false)
    // The branch deletion stage was invoked and returned failure.
    expect(shouldRecordCleanupFailure(true, false)).toBe(true)
    expect(shouldRecordCleanupFailure(true, true)).toBe(false)
  })
})

describe("fastForwardDecision", () => {
  const ready = { enabled: true, merged: true, onBaseBranch: true, clean: true, localOnly: 0, remoteOnly: 3 }

  test("fast-forwards only a clean base branch that is strictly behind the forge", () => {
    expect(fastForwardDecision(ready)).toEqual({ advance: true })
  })

  test("does nothing when disabled, unmerged, equal, dirty, on the wrong branch, or diverged/ahead", () => {
    const cases = [
      [{ enabled: false }, "fast-forward is disabled"],
      [{ merged: false }, "PR was not merged; local base left unchanged"],
      [{ remoteOnly: 0 }, "local base is already up to date"],
      [{ clean: false }, "local base checkout has changes"],
      [{ onBaseBranch: false }, "local checkout is not on the base branch"],
      [{ localOnly: 1 }, "local base has commits not present on the forge; left it unchanged"],
    ] as const
    for (const [override, message] of cases)
      expect(fastForwardDecision({ ...ready, ...override })).toEqual({ advance: false, message })
  })
})

describe("shouldFastForwardBase", () => {
  test("only runs after a successful merge when the setting is enabled", () => {
    expect(shouldFastForwardBase(false, true)).toBe(false)
    expect(shouldFastForwardBase(true, false)).toBe(false)
    expect(shouldFastForwardBase(true, true)).toBe(true)
  })
})

describe("safeFastForward", () => {
  test("turns a rejected local operation into a failure result without throwing", async () => {
    await expect(safeFastForward(Promise.reject(new Error("fetch failed")))).resolves.toEqual({
      fastForwarded: false,
      message: "local fast-forward failed: fetch failed",
    })
  })
})

describe("cleanupDecision", () => {
  const ready = {
    enabled: true,
    merged: true,
    sameRepo: true,
    managedWorktree: true,
    branchMatches: true,
    headMatches: true,
    clean: true,
  }

  test("allows only a successful merge of the matching clean managed worktree", () => {
    expect(cleanupDecision(ready)).toEqual({ remove: true })
  })

  test("skips disabled cleanup, failed merges, and unsafe targets", () => {
    const cases = [
      [{ enabled: false }, "local cleanup is disabled"],
      [{ merged: false }, "PR was not merged; local worktree left intact"],
      [{ sameRepo: false }, "PR belongs to another repository; local worktree left intact"],
      [{ managedWorktree: false }, "session is not in a registered OpenCode worktree; left it intact"],
      [{ branchMatches: false }, "local worktree is not on the PR branch; left it intact"],
      [{ headMatches: false }, "local branch differs from the merged PR head; left it intact"],
      [{ clean: false }, "local worktree has changes; left it intact"],
    ] as const
    for (const [override, message] of cases)
      expect(cleanupDecision({ ...ready, ...override })).toEqual({ remove: false, message })
  })
})

describe("cleanupResultMessage", () => {
  test("distinguishes complete, partial, and skipped cleanup", () => {
    expect(cleanupResultMessage(true, true)).toBe("local tree and branch deleted")
    expect(cleanupResultMessage(true, false, "branch not safely deletable")).toBe("worktree removed; local branch kept: branch not safely deletable")
    expect(cleanupResultMessage(false, false, "worktree was dirty")).toBe("worktree was dirty")
    expect(cleanupResultMessage(true, true, undefined, true)).toBe("session switched to the base checkout; local tree and branch deleted")
    expect(cleanupResultMessage(false, false, "removal failed", true)).toBe("session switched to the base checkout; old worktree left intact: removal failed")
  })
})
