import { describe, expect, test } from "bun:test"
import { mergeResponse, staleHeadConflict, toPullEntity, runEntity, toIssueEntity, statusCheckSnapshot, combineStatusCheckResults, decodeStatusPage, collectStatusPages, cachedPromise, statusCheckCacheKey, shouldLoadStatusChecks } from "./github"
import { PullEntity, RunEntity as RunEntitySchema } from "../rpc"

describe("mergeResponse", () => {
  test("a confirmed merge succeeds, with or without a message", () => {
    expect(mergeResponse({ merged: true })).toEqual({ merged: true })
    expect(mergeResponse({ merged: true, message: "squashed" })).toEqual({ merged: true })
  })

  test("an unconfirmed 200 fails with the provider's message", () => {
    expect(mergeResponse({ merged: false, message: "Already merged" })).toEqual({
      merged: false,
      message: "Already merged",
    })
    expect(mergeResponse({ merged: false })).toEqual({
      merged: false,
      message: "GitHub did not confirm that the pull request merged",
    })
  })

  test("an object body without confirmation fails with the unconfirmed message", () => {
    expect(mergeResponse({})).toEqual({
      merged: false,
      message: "GitHub did not confirm that the pull request merged",
    })
    expect(mergeResponse({ merged: "yes" })).toEqual({
      merged: false,
      message: "GitHub did not confirm that the pull request merged",
    })
  })

  test("non-object bodies fail with the invalid-response message", () => {
    const invalid = { merged: false, message: "GitHub returned an invalid merge response" }
    expect(mergeResponse(null)).toEqual(invalid)
    expect(mergeResponse(undefined)).toEqual(invalid)
    expect(mergeResponse("merged")).toEqual(invalid)
    expect(mergeResponse(42)).toEqual(invalid)
  })
})

describe("staleHeadConflict", () => {
  test("classifies only a 409 confirmed against a different current head", () => {
    expect(staleHeadConflict(409, "old-head", "new-head")).toBe(true)
    expect(staleHeadConflict(409, "head", "head")).toBe(false)
    expect(staleHeadConflict(409, "head", undefined)).toBe(false)
    expect(staleHeadConflict(422, "old-head", "new-head")).toBe(false)
  })
})

describe("PullEntity RPC schema", () => {
  test("accepts merge timestamps while remaining compatible with cached entities", () => {
    const entity = {
      kind: "pr",
      provider: "github",
      repo: { host: "github.com", owner: "octo", repo: "repo" },
      number: 1,
      title: "Merged change",
      state: "merged",
      headBranch: "feature",
      baseBranch: "main",
      closes: [],
      headSha: "abc",
      url: "https://github.com/octo/repo/pull/1",
      updatedAt: 1,
    }
    const timestamp = 1_794_192_637_000
    expect(PullEntity.parse({ ...entity, mergedAt: timestamp }).mergedAt).toBe(timestamp)
    expect(PullEntity.parse(entity).mergedAt).toBeUndefined()
    const checks = { headSha: "abc", state: "available" as const, contexts: [{ name: "gate", status: "running" as const }] }
    expect(PullEntity.parse({ ...entity, statusChecks: checks }).statusChecks).toEqual(checks)
  })
})

describe("RunEntity RPC schema", () => {
  test("accepts optional workflow-series metadata and legacy runs", () => {
    const run = {
      kind: "run",
      provider: "github",
      repo: { host: "github.com", owner: "octo", repo: "repo" },
      id: 1,
      name: "CI",
      headBranch: "feature",
      headSha: "abc",
      status: "succeeded",
      checks: [],
      pullRequests: [1],
      url: "https://github.com/octo/repo/actions/runs/1",
      updatedAt: 1,
    }
    expect(RunEntitySchema.parse(run).series).toBeUndefined()
    expect(RunEntitySchema.parse({ ...run, series: { key: "workflow-1", sequence: 1 } }).series).toEqual({
      key: "workflow-1",
      sequence: 1,
    })
  })
})

describe("toPullEntity", () => {
  const repo = { host: "github.com", owner: "octo", repo: "repo" }
  const basePull = {
    node_id: "n1",
    number: 7,
    title: "T",
    state: "open",
    draft: false,
    merged_at: null,
    body: null,
    html_url: "https://github.com/octo/repo/pull/7",
    head: { sha: "abc", ref: "feature" },
    base: { ref: "main" },
    mergeable: null,
    mergeable_state: "unknown",
    auto_merge: null,
    updated_at: "2026-11-10T00:00:00Z",
  } as const

  test("an open pull carries no mergedAt key at all — undefined fails strict JSON", () => {
    const entity = toPullEntity(repo, { ...basePull })
    expect("mergedAt" in entity).toBe(false)
  })

  test("a merged pull carries the merge timestamp", () => {
    const entity = toPullEntity(repo, { ...basePull, merged_at: "2026-11-10T00:33:47Z", state: "closed" })
    expect(entity.mergedAt).toBe(Date.parse("2026-11-10T00:33:47Z"))
    expect(entity.state).toBe("merged")
  })
})

describe("statusCheckSnapshot", () => {
  test("keeps the latest state for each context and maps GitHub states conservatively", () => {
    const snapshot = statusCheckSnapshot("head-1", [
      { id: 1, context: "fresnel/renovate-ci", state: "pending", updated_at: "2026-11-10T00:00:00Z" },
      { id: 2, context: "fresnel/renovate-ci", state: "success", updated_at: "2026-11-10T00:01:00Z" },
      { id: 3, context: "legacy-check", state: "error", updated_at: "2026-11-10T00:00:30Z" },
    ])
    expect(snapshot).toEqual({
      headSha: "head-1",
      state: "available",
      contexts: [
        { name: "status-context:fresnel/renovate-ci", status: "succeeded" },
        { name: "status-context:legacy-check", status: "failed" },
      ],
    })
  })

  test("uses the latest attempt per app and check name; GitHub treats success, neutral, and skipped as passed", () => {
    const snapshot = statusCheckSnapshot("head-2", [], [
      { id: 1, name: "Build", status: "completed", conclusion: "failure", app: { id: 10 } },
      { id: 2, name: "Build", status: "completed", conclusion: "success", app: { id: 10 } },
      { id: 3, name: "Build", status: "completed", conclusion: "success", app: { id: 11 } },
      { id: 4, name: "Deploy", status: "completed", conclusion: "skipped", app: { id: 10 } },
      { id: 6, name: "Lint", status: "completed", conclusion: "neutral", app: { id: 10 } },
      { id: 5, name: "Test", status: "in_progress", conclusion: null, app: { id: 10 } },
      { id: 7, name: "Audit", status: "completed", conclusion: "timed_out", app: { id: 10 } },
      { id: 8, name: "Missing conclusion", status: "completed", conclusion: null, app: { id: 10 } },
      { id: 9, name: "Unknown conclusion", status: "completed", conclusion: "future", app: { id: 10 } },
    ])
    expect(snapshot.contexts).toEqual([
      { name: "check-run:10:Build", status: "succeeded" },
      { name: "check-run:11:Build", status: "succeeded" },
      { name: "check-run:10:Deploy", status: "succeeded" },
      { name: "check-run:10:Lint", status: "succeeded" },
      { name: "check-run:10:Test", status: "running" },
      { name: "check-run:10:Audit", status: "failed" },
      { name: "check-run:10:Missing conclusion", status: "failed" },
      { name: "check-run:10:Unknown conclusion", status: "failed" },
    ])
  })

  test("decodes both GitHub response shapes and accumulates every page", async () => {
    const first = Array.from({ length: 100 }, (_, id) => ({ id }))
    const last = [{ id: 100 }]
    expect(decodeStatusPage<{ id: number }>(first)).toEqual(first)
    expect(decodeStatusPage<{ id: number }>({ check_runs: first }, "check_runs")).toEqual(first)
    expect(decodeStatusPage({ malformed: [] }, "check_runs")).toBeUndefined()
    const all = await collectStatusPages(async (page) => (page === 1 ? first : last))
    expect(all).toHaveLength(101)
    expect(await collectStatusPages(async (page) => (page === 1 ? first : undefined))).toBeUndefined()
  })

  test("does not mark partial API discovery available, but accepts two complete empty results", () => {
    expect(combineStatusCheckResults("head", [], undefined)).toEqual({ headSha: "head", state: "unavailable", contexts: [] })
    expect(combineStatusCheckResults("head", undefined, [])).toEqual({ headSha: "head", state: "unavailable", contexts: [] })
    expect(combineStatusCheckResults("head", [], [])).toEqual({ headSha: "head", state: "available", contexts: [] })
  })
})

describe("status-check caching", () => {
  test("shares in-flight promises and refreshes once the fixed TTL expires", async () => {
    const cache = new Map<string, { at: number; promise: Promise<string> }>()
    let loads = 0
    const load = async () => String(++loads)
    const first = cachedPromise(cache, "key", 20, load, 0)
    const concurrent = cachedPromise(cache, "key", 20, load, 10)
    expect(concurrent).toBe(first)
    expect(await concurrent).toBe("1")
    const refreshed = cachedPromise(cache, "key", 20, load, 20)
    expect(refreshed).not.toBe(first)
    expect(await refreshed).toBe("2")
    expect(loads).toBe(2)
  })

  test("a failed refresh replaces the prior success instead of falling back to it", async () => {
    const cache = new Map<string, { at: number; promise: Promise<string> }>()
    const success = cachedPromise(cache, "key", 20, async () => "available", 0)
    expect(await success).toBe("available")
    const failedRefresh = cachedPromise(cache, "key", 20, async () => "unavailable", 20)
    expect(await failedRefresh).toBe("unavailable")
    expect(await cachedPromise(cache, "key", 20, async () => "should-not-load", 21)).toBe("unavailable")
  })

  test("scopes cache identity by host, repository, SHA, and opaque credential fingerprint", () => {
    const repo = { host: "github.com", owner: "octo", repo: "repo" }
    const first = statusCheckCacheKey(repo, "sha-1", "secret-token-one")
    expect(statusCheckCacheKey(repo, "sha-1", "secret-token-one")).toBe(first)
    expect(statusCheckCacheKey(repo, "sha-1", "secret-token-two")).not.toBe(first)
    expect(statusCheckCacheKey(repo, "sha-2", "secret-token-one")).not.toBe(first)
    expect(statusCheckCacheKey({ ...repo, host: "ghe.example" }, "sha-1", "secret-token-one")).not.toBe(first)
    expect(first).not.toContain("secret-token-one")
  })

  test("only open pull requests need status discovery", () => {
    expect(shouldLoadStatusChecks({ state: "open" })).toBe(true)
    expect(shouldLoadStatusChecks({ state: "draft" })).toBe(false)
    expect(shouldLoadStatusChecks({ state: "closed" })).toBe(false)
    expect(shouldLoadStatusChecks({ state: "merged" })).toBe(false)
  })
})

describe("strict JSON boundary", () => {
  // The transport encodes responses with a strict JSON schema: a property
  // whose value is undefined (or a non-finite number) fails the ENTIRE
  // response — zod's optional() is lenient where the wire is not, so schema
  // tests alone cannot catch this class. Scan every entity kind a provider
  // can emit.
  const jsonIssues = (value: unknown, path = "output"): string[] => {
    if (value === undefined) return [`${path} = undefined`]
    if (typeof value === "number" && !Number.isFinite(value)) return [`${path} = ${value}`]
    if (Array.isArray(value)) return value.flatMap((item, index) => jsonIssues(item, `${path}[${index}]`))
    if (value !== null && typeof value === "object")
      return Object.entries(value).flatMap(([key, item]) => jsonIssues(item, `${path}.${key}`))
    return []
  }

  const repo = { host: "github.com", owner: "octo", repo: "repo" }
  const pullFixture = (overrides: Record<string, unknown>) =>
    toPullEntity(repo, {
      node_id: "n1",
      number: 7,
      title: "T",
      state: "open",
      draft: false,
      merged_at: null,
      body: null,
      html_url: "https://github.com/octo/repo/pull/7",
      head: { sha: "abc", ref: "feature" },
      base: { ref: "main" },
      mergeable: null,
      mergeable_state: "unknown",
      auto_merge: null,
      updated_at: "2026-11-10T00:00:00Z",
      ...overrides,
    })

  test("every pull shape is strict-JSON safe", () => {
    const shapes = [
      pullFixture({}), // open
      pullFixture({ state: "closed" }), // closed, unmerged
      pullFixture({ state: "closed", merged_at: "2026-11-10T00:33:47Z" }), // merged
      pullFixture({ draft: true }), // draft
      pullFixture({ auto_merge: { merge_method: "squash" } }), // armed on the forge
    ]
    for (const entity of shapes) expect(jsonIssues(entity)).toEqual([])
  })

  test("run and issue builders emit strict-JSON-safe entities", async () => {
    // Real builders, not literals: a `cond ? value : undefined` regression in
    // either one must fail here, not the wire.
    const run = await runEntity(
      repo,
      {
        id: 1,
        workflow_id: 777,
        name: "",
        display_title: "ci: unit",
        status: "completed",
        conclusion: "success",
        head_branch: "main",
        head_sha: "abc",
        html_url: "https://github.com/octo/repo/actions/runs/1",
        updated_at: "2026-11-10T00:00:00Z",
        pull_requests: [],
      },
      async () => undefined,
      false,
    )
    expect(run.name).toBe("ci: unit") // the display_title fallback behavior
    expect(run.series).toEqual({ key: "777", sequence: 1 })
    expect(jsonIssues(run)).toEqual([])

    const issue = toIssueEntity(repo, {
      number: 2,
      title: "T",
      state: "open",
      body: null,
      html_url: "https://github.com/octo/repo/issues/2",
      updated_at: "2026-11-10T00:00:00Z",
    })
    expect(jsonIssues(issue)).toEqual([])
  })
})
