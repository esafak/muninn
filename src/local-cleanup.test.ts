import { describe, expect, test } from "bun:test"
import { baseCheckoutDecision, cleanFromCheck, cleanupDecision, cleanupResultMessage, cleanupSessionMatches, fastForwardDecision, isCleanStatus, isSameRepo, locateCheckout, safeFastForward, selectCanonicalRemote, selectDirectRemote, sessionMoveConfirmed, shouldFastForwardBase, shouldRecordCleanupFailure, untrackedFilesArg, worktreeOccupancyDecision } from "./local-cleanup"

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

  test("surfaces the clean-check message on fail-closed vetoes without overriding earlier gates", () => {
    const ready = { differentTree: true, onBaseBranch: true, clean: false }
    expect(baseCheckoutDecision(ready)).toEqual({
      move: false,
      message: "canonical checkout has changes; worktree left intact",
    })
    expect(baseCheckoutDecision({ ...ready, cleanMessage: "git failed: timeout" })).toEqual({
      move: false,
      message: "git failed: timeout",
    })
    expect(baseCheckoutDecision({ ...ready, onBaseBranch: false, cleanMessage: "git failed: timeout" })).toEqual({
      move: false,
      message: "canonical checkout is not on the PR base branch; worktree left intact",
    })
    expect(baseCheckoutDecision({ ...ready, differentTree: false, cleanMessage: "git failed: timeout" })).toEqual({
      move: false,
      message: "worktree is the canonical checkout; left it intact",
    })
  })
})

describe("canonical tracked-only cleanliness", () => {
  test("selects the tracked-only flag for canonical gates and strict for removal", () => {
    expect(untrackedFilesArg(true)).toBe("--untracked-files=no")
    expect(untrackedFilesArg()).toBe("--untracked-files=all")
    expect(untrackedFilesArg(false)).toBe("--untracked-files=all")
  })

  test("classifies empty output as clean and any rows as dirty", () => {
    expect(isCleanStatus("")).toBe(true)
    expect(isCleanStatus(" M src/index.ts\n")).toBe(false)
    expect(isCleanStatus("?? .worktrees/feature/dependency-check-mode/\n")).toBe(false)
  })

  test("canonical gate moves on tracked-only clean and vetoes tracked dirt", () => {
    // Tracked-only `git status --untracked-files=no` suppresses `??` rows, so
    // the canonical gate sees "" while the strict removal gate would see the
    // untracked rows.
    const trackedOnlyClean = isCleanStatus("")
    expect(baseCheckoutDecision({ differentTree: true, onBaseBranch: true, clean: trackedOnlyClean })).toEqual({ move: true })
    const trackedDirty = isCleanStatus(" M src/index.ts\n")
    expect(baseCheckoutDecision({ differentTree: true, onBaseBranch: true, clean: trackedDirty })).toEqual({
      move: false,
      message: "canonical checkout has changes; worktree left intact",
    })
  })

  test("removal gate stays strict: untracked rows still veto", () => {
    const strictSeesUntracked = isCleanStatus("?? plan.md\n")
    expect(strictSeesUntracked).toBe(false)
    expect(
      cleanupDecision({ enabled: true, merged: true, sameRepo: true, managedWorktree: true, branchMatches: true, headMatches: true, clean: strictSeesUntracked }),
    ).toEqual({ remove: false, message: "local worktree has changes; left it intact" })
  })

  test("missing checkClean result is fail-closed", () => {
    expect(cleanFromCheck(undefined)).toBe(false)
    expect(cleanFromCheck({ clean: true })).toBe(true)
    expect(cleanFromCheck({ clean: false })).toBe(false)
    expect(baseCheckoutDecision({ differentTree: true, onBaseBranch: true, clean: cleanFromCheck(undefined) }).move).toBe(false)
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

describe("locateCheckout", () => {
  const projects = [
    { canonical: "/repo", trees: ["/trees/a", "/trees/b"] },
    { canonical: "/other", trees: [] as string[] },
  ]

  test("routes linked worktrees, canonical checkouts, and unmanaged directories", () => {
    expect(locateCheckout(projects, "/trees/a")).toBe("worktree")
    expect(locateCheckout(projects, "/trees/b")).toBe("worktree")
    expect(locateCheckout(projects, "/repo")).toBe("canonical")
    expect(locateCheckout(projects, "/other")).toBe("canonical")
    expect(locateCheckout(projects, "/elsewhere")).toBe("unmanaged")
    expect(locateCheckout([], "/repo")).toBe("unmanaged")
  })

  test("matches exact directories, never prefixes", () => {
    expect(locateCheckout(projects, "/repo2")).toBe("unmanaged")
    expect(locateCheckout(projects, "/trees/a-child")).toBe("unmanaged")
    expect(locateCheckout(projects, "/trees")).toBe("unmanaged")
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

describe("remote selection (renames)", () => {
  const expected = { host: "github.com", owner: "esafak", repo: "kotlin-tsgen" }
  const stale = { host: "github.com", owner: "esafak", repo: "kotlinx-serialization-typescript-generator" }

  test("direct match is case-insensitive and first wins", () => {
    expect(selectDirectRemote([{ name: "origin", remote: expected }], expected)).toBe("origin")
    expect(selectDirectRemote([{ name: "origin", remote: { ...expected, owner: "ESafak", repo: "Kotlin-Tsgen" } }], expected)).toBe("origin")
    expect(selectDirectRemote([{ name: "unrelated", remote: { host: "github.com", owner: "other", repo: "repo" } }], expected)).toBeUndefined()
    expect(selectDirectRemote([{ name: "broken", remote: undefined }], expected)).toBeUndefined()
  })

  test("canonical match tolerates a stale alias without blocking later candidates", () => {
    const candidates = [
      { name: "upstream", remote: { host: "github.com", owner: "other", repo: "repo" } },
      { name: "origin", remote: stale },
      { name: "backup", remote: stale },
    ]
    expect(selectCanonicalRemote(candidates, expected, new Map())).toBeUndefined()
    expect(selectCanonicalRemote(candidates, expected, new Map([["origin", undefined], ["backup", expected]]))).toBe("backup")
    expect(selectCanonicalRemote(candidates, expected, new Map([["origin", expected]]))).toBe("origin")
  })

  test("canonical match stays same-host and case-insensitive", () => {
    const otherHost = [{ name: "origin", remote: stale }]
    expect(selectCanonicalRemote(otherHost, { ...expected, host: "ghe.example" }, new Map([["origin", expected]]))).toBeUndefined()
    expect(isSameRepo({ ...expected, repo: "KOTLIN-TSGEN" }, expected)).toBe(true)
    expect(isSameRepo(stale, expected)).toBe(false)
  })
})
