import { describe, expect, test } from "bun:test"
import type { Chain, IssueEntity, PullEntity, RepoRef, RunEntity } from "./model"
import { chainTone, mergeFailed, mergeReady, mergeWhy, pendingReviewNotice, armedTargets, staleHeadRetryEligible, staleHeadEvidenceUsable, sessionAttemptCurrent, targetRefreshConfirmed, pillPick, pillPicks, type ArmedEntry, pillEligible, pillHeadIdentity, pillLeadOf, rememberCreated, pullForRun, pullsForRun, jsonReady, prConflicted, isFreshBaseSession, menuChains, entityKey } from "./model"
import { associate } from "./associate"

const repo = { host: "github.com", owner: "sst", repo: "opencode" }

const pull = (over: Partial<PullEntity> = {}): PullEntity => {
  const base = {
    kind: "pr" as const,
    provider: "github",
    repo,
    number: 4821,
    title: "feat: thing",
    state: "open" as const,
    headBranch: "feat/thing",
    baseBranch: "main",
    closes: [],
    headSha: "abc123",
    url: "https://github.com/sst/opencode/pull/4821",
    updatedAt: 0,
    ...over,
  }
  return {
    ...base,
    statusChecks: over.statusChecks ?? { headSha: base.headSha, state: "available", contexts: [] },
  }
}

const run = (status: RunEntity["status"]): RunEntity => ({
  kind: "run",
  provider: "github",
  repo,
  id: 906,
  name: "ci",
  headBranch: "feat/thing",
  headSha: "abc123",
  status,
  checks: [],
  pullRequests: [4821],
  url: "https://github.com/sst/opencode/actions/runs/906",
  updatedAt: 0,
})

const issue = (state: IssueEntity["state"]): IssueEntity => ({
  kind: "issue",
  provider: "github",
  repo,
  number: 1043,
  title: "bug: thing",
  state,
  url: "https://github.com/sst/opencode/issues/1043",
  updatedAt: 0,
})

const chain = (over: Partial<Chain> = {}): Chain => ({
  key: "k",
  prs: [pull()],
  issues: [],
  runs: [run("succeeded")],
  updatedAt: 0,
  ...over,
})

describe("mergeReady", () => {
  test("green checks + clean merge state is ready", () => {
    expect(mergeReady(chain({ prs: [pull({ mergeState: "ready", reviewState: "approved" })] }))).toBe(true)
  })

  test("unknown states (older cache) fall back to checks alone", () => {
    expect(mergeReady(chain())).toBe(true)
  })

  test("conflicts and change requests block, regardless of checks", () => {
    expect(mergeReady(chain({ prs: [pull({ mergeState: "conflict" })] }))).toBe(false)
    expect(mergeReady(chain({ prs: [pull({ reviewState: "changes_requested" })] }))).toBe(false)
  })

  test("blocked or pending merge states block until clean", () => {
    expect(mergeReady(chain({ prs: [pull({ mergeState: "blocked" })] }))).toBe(false)
    expect(mergeReady(chain({ prs: [pull({ mergeState: "pending" })] }))).toBe(false)
  })

  test("no evidence, no merge: zero runs with unknown or absent merge state is not ready", () => {
    expect(mergeReady(chain({ runs: [] }))).toBe(false)
    expect(mergeReady(chain({ runs: [], prs: [pull({ mergeState: null })] }))).toBe(false)
  })

  test("the provider's explicit clean state is evidence enough without runs", () => {
    expect(mergeReady(chain({ runs: [], prs: [pull({ mergeState: "ready" })] }))).toBe(true)
  })

  test("runs-present behavior unchanged", () => {
    expect(mergeReady(chain({ runs: [run("queued")] }))).toBe(false)
    expect(mergeReady(chain({ runs: [run("succeeded")] }))).toBe(true)
    expect(mergeReady(chain({ runs: [run("succeeded"), run("failed")] }))).toBe(false)
  })

  test("a later successful run supersedes an older cancelled or failed run in the same series", () => {
    const cancelled = { ...run("cancelled"), id: 10, updatedAt: 20, series: { key: "workflow-1", sequence: 10 } }
    const latest = { ...run("succeeded"), id: 11, updatedAt: 10, series: { key: "workflow-1", sequence: 11 } }
    const failed = { ...run("failed"), id: 9, series: { key: "workflow-1", sequence: 9 } }
    expect(mergeReady(chain({ runs: [cancelled, failed, latest] }))).toBe(true)
    expect(mergeReady(chain({ runs: [latest, failed, cancelled] }))).toBe(true)
    expect(mergeWhy(chain({ runs: [cancelled, failed, latest] }))).toBe("not ready")
  })

  test("latest queued, running, failed, or cancelled run in a series still blocks", () => {
    const statuses: RunEntity["status"][] = ["queued", "running", "failed", "cancelled"]
    for (const status of statuses) {
      const earlierSuccess = { ...run("succeeded"), id: 20, series: { key: "workflow-1", sequence: 20 } }
      const latest = { ...run(status), id: 21, series: { key: "workflow-1", sequence: 21 } }
      expect(mergeReady(chain({ runs: [earlierSuccess, latest] })), status).toBe(false)
    }
    const cancelled = { ...run("cancelled"), id: 31, series: { key: "workflow-1", sequence: 31 } }
    expect(mergeWhy(chain({ runs: [cancelled] }))).toBe("checks cancelled (run #31)")
  })

  test("separate workflow series block independently even when names match", () => {
    const passing = { ...run("succeeded"), id: 40, series: { key: "workflow-1", sequence: 40 } }
    const failing = { ...run("failed"), id: 41, series: { key: "workflow-2", sequence: 41 } }
    expect(mergeReady(chain({ runs: [passing, failing] }))).toBe(false)
  })

  test("different repositories and heads do not join a workflow series", () => {
    const otherRepo = { ...repo, owner: "someone-else" }
    const cancelled = { ...run("cancelled"), id: 50, repo: otherRepo, series: { key: "workflow-1", sequence: 50 } }
    const staleHead = { ...run("cancelled"), id: 51, headSha: "old-head", series: { key: "workflow-1", sequence: 51 } }
    expect(mergeReady(chain({ runs: [run("succeeded"), cancelled, staleHead] }))).toBe(true)
  })

  test("missing series metadata remains independent and duplicate order ties block conservatively", () => {
    const cancelledWithoutSeries = { ...run("cancelled"), id: 60 }
    expect(mergeReady(chain({ runs: [run("succeeded"), cancelledWithoutSeries] }))).toBe(false)
    const tiedSuccess = { ...run("succeeded"), id: 61, series: { key: "workflow-1", sequence: 61 } }
    const tiedCancelled = { ...run("cancelled"), id: 62, series: { key: "workflow-1", sequence: 61 } }
    expect(mergeReady(chain({ runs: [tiedSuccess, tiedCancelled] }))).toBe(false)
    expect(mergeReady(chain({ runs: [tiedCancelled, tiedSuccess] }))).toBe(false)
  })

  test("current-head status contexts must all succeed by default", () => {
    const context = (status: "running" | "succeeded" | "failed" | "cancelled") => ({ name: "fresnel/renovate-ci", status })
    expect(mergeReady(chain({ prs: [pull({ statusChecks: { headSha: "abc123", state: "available", contexts: [context("running")] } })] }))).toBe(false)
    expect(mergeReady(chain({ prs: [pull({ statusChecks: { headSha: "abc123", state: "available", contexts: [context("failed")] } })] }))).toBe(false)
    expect(mergeReady(chain({ prs: [pull({ statusChecks: { headSha: "abc123", state: "available", contexts: [context("succeeded")] } })] }))).toBe(true)
    expect(mergeReady(chain({ prs: [pull({ statusChecks: { headSha: "abc123", state: "available", contexts: [] } })] }))).toBe(true)
  })

  test("unknown, unavailable, and stale status snapshots block; disabling the setting ignores them", () => {
    const unknown = { ...pull(), statusChecks: undefined }
    const unavailable = pull({ statusChecks: { headSha: "abc123", state: "unavailable", contexts: [] } })
    const stale = pull({ headSha: "new-head", statusChecks: { headSha: "abc123", state: "available", contexts: [{ name: "old", status: "succeeded" }] } })
    expect(mergeReady(chain({ prs: [unknown] }))).toBe(false)
    expect(mergeReady(chain({ prs: [unavailable] }))).toBe(false)
    expect(mergeReady(chain({ prs: [stale] }))).toBe(false)
    expect(mergeReady(chain({ prs: [unavailable] }), unavailable, false)).toBe(true)
    const unsupported = pull({ statusChecks: { headSha: "abc123", state: "unsupported", contexts: [] } })
    expect(mergeReady(chain({ prs: [unsupported] }))).toBe(true)
    expect(mergeReady(chain({ prs: [pull({ statusChecks: { headSha: "abc123", state: "available", contexts: [{ name: "pending", status: "running" }] } })], runs: [run("failed")] }), undefined, false)).toBe(false)
  })

  test("a refreshed current-head status can move from pending to succeeded", () => {
    const pending = pull({ statusChecks: { headSha: "abc123", state: "available", contexts: [{ name: "gate", status: "running" }] } })
    const passed = pull({ statusChecks: { headSha: "abc123", state: "available", contexts: [{ name: "gate", status: "succeeded" }] } })
    expect(mergeReady(chain({ prs: [pending] }))).toBe(false)
    expect(mergeReady(chain({ prs: [passed] }))).toBe(true)
  })

  test("red checks, closed and merged PRs are not ready", () => {
    expect(mergeReady(chain({ runs: [run("failed")] }))).toBe(false)
    expect(mergeReady(chain({ prs: [pull({ state: "merged" })] }))).toBe(false)
    expect(mergeReady(chain({ prs: [] }))).toBe(false)
  })

  test("stale runs from earlier commits neither block nor fabricate evidence", () => {
    const previousRun = { ...run("failed"), headSha: "previous-head" }
    // No current-head evidence and no merge state: not mergeable (no evidence, no merge)…
    expect(mergeReady(chain({ runs: [previousRun] }))).toBe(false)
    // …but the provider's explicit clean state is evidence on its own…
    expect(mergeReady(chain({ runs: [previousRun], prs: [pull({ mergeState: "ready" })] }))).toBe(true)
    // …and a current green run still merges despite the stale failure.
    expect(mergeReady(chain({ runs: [previousRun, run("succeeded")] }))).toBe(true)
  })

  test("readiness can be evaluated for a selected PR in a grouped chain", () => {
    const closedLead = pull({ state: "merged", number: 1, headSha: "old-head" })
    const openTarget = pull({ state: "open", number: 2, headSha: "current-head" })
    const oldFailure = { ...run("failed"), headSha: "old-head" }
    const currentSuccess = { ...run("succeeded"), headSha: "current-head" }
    const grouped = chain({ prs: [closedLead, openTarget], runs: [oldFailure, currentSuccess] })
    expect(mergeReady(grouped, openTarget)).toBe(true)
    expect(mergeWhy(grouped, openTarget)).toBe("not ready")
  })
})

describe("prConflicted", () => {
  test("only open conflicting PRs use the conflict glyph", () => {
    expect(prConflicted(pull({ mergeState: "conflict" }))).toBe(true)
    expect(prConflicted(pull({ state: "draft", mergeState: "conflict" }))).toBe(false)
    expect(prConflicted(pull({ state: "merged", mergeState: "conflict" }))).toBe(false)
    expect(prConflicted(pull({ state: "closed", mergeState: "conflict" }))).toBe(false)
    expect(prConflicted(pull({ mergeState: "ready" }))).toBe(false)
    expect(prConflicted(pull({ mergeState: null }))).toBe(false)
    expect(prConflicted(pull())).toBe(false)
  })
})

describe("mergeWhy", () => {
  test("names the first blocking reason", () => {
    expect(mergeWhy(chain({ runs: [run("failed")] }))).toBe("checks failed (run #906)")
    expect(mergeWhy(chain({ runs: [run("running")] }))).toBe("checks still running")
    expect(mergeWhy(chain({ prs: [pull({ reviewState: "changes_requested" })] }))).toBe("changes requested")
    expect(mergeWhy(chain({ prs: [pull({ mergeState: "conflict" })] }))).toBe("merge conflicts with the base branch")
    expect(mergeWhy(chain({ prs: [pull({ mergeState: "blocked" })] }))).toBe("blocked by branch rules or a missing review")
    expect(mergeWhy(chain({ prs: [pull({ state: "merged" })] }))).toBe("pull request is not open")
  })

  test("names the missing-evidence block instead of a generic not ready", () => {
    // Zero runs, unknown state: the exact chain the evidence gate newly blocks.
    expect(mergeWhy(chain({ runs: [] }))).toBe("no checks on record for the current head")
    // Stale runs from earlier heads are not evidence either.
    const stale = chain({ runs: [{ ...run("failed"), headSha: "previous-head" }] })
    expect(mergeWhy(stale)).toBe("no checks on record for the current head")
    // But the provider's clean state is evidence — nothing to explain here, and
    // a run on the current head keeps the ordinary reasons in charge.
    expect(mergeWhy(chain({ runs: [], prs: [pull({ mergeState: "ready" })] }))).toBe("not ready")
    expect(mergeWhy(chain({ runs: [run("failed")] }))).toBe("checks failed (run #906)")
  })

  test("explains status-check blockers and preserves the previous reason when disabled", () => {
    const statusPull = (statusChecks: PullEntity["statusChecks"]): PullEntity => ({ ...pull(), statusChecks })
    const explain = (statusChecks: PullEntity["statusChecks"], wait = true) =>
      mergeWhy(chain({ prs: [statusPull(statusChecks)] }), undefined, wait)
    expect(explain(undefined)).toBe("status checks unavailable")
    expect(explain({ headSha: "old-head", state: "available", contexts: [] })).toBe("status checks unavailable")
    expect(explain({ headSha: "abc123", state: "unavailable", contexts: [] })).toBe("status checks unavailable")
    expect(explain({ headSha: "abc123", state: "available", contexts: [{ name: "gate", status: "failed" }] })).toBe("status checks failed")
    expect(explain({ headSha: "abc123", state: "available", contexts: [{ name: "gate", status: "running" }] })).toBe("status checks still running")
    expect(explain({ headSha: "abc123", state: "available", contexts: [{ name: "gate", status: "cancelled" }] })).toBe("status checks did not succeed")
    const pendingAndBlocked = pull({
      mergeState: "blocked",
      statusChecks: { headSha: "abc123", state: "available", contexts: [{ name: "gate", status: "running" }] },
    })
    expect(mergeWhy(chain({ prs: [pendingAndBlocked] }), pendingAndBlocked, false)).toBe("blocked by branch rules or a missing review")
  })
})

describe("mergeFailed", () => {
  const context = (status: "running" | "succeeded" | "failed" | "cancelled") => ({ name: "gate", status })

  test("failed or cancelled current-head runs are hard-blocked", () => {
    expect(mergeFailed(chain({ runs: [run("failed")] }))).toBe(true)
    expect(mergeFailed(chain({ runs: [run("cancelled")] }))).toBe(true)
  })

  test("running or queued runs are merely waiting", () => {
    expect(mergeFailed(chain({ runs: [run("running")] }))).toBe(false)
    expect(mergeFailed(chain({ runs: [run("queued")] }))).toBe(false)
  })

  test("status contexts only fail when fresh, available, and opted in", () => {
    const failed = pull({ statusChecks: { headSha: "abc123", state: "available", contexts: [context("failed")] } })
    const cancelled = pull({ statusChecks: { headSha: "abc123", state: "available", contexts: [context("cancelled")] } })
    const stale = pull({ headSha: "new-head", statusChecks: { headSha: "abc123", state: "available", contexts: [context("failed")] } })
    const unavailable = pull({ statusChecks: { headSha: "abc123", state: "unavailable", contexts: [context("failed")] } })
    expect(mergeFailed(chain({ prs: [failed] }), failed)).toBe(true)
    expect(mergeFailed(chain({ prs: [cancelled] }), cancelled)).toBe(true)
    expect(mergeFailed(chain({ prs: [stale] }), stale)).toBe(false)
    expect(mergeFailed(chain({ prs: [unavailable] }), unavailable)).toBe(false)
    expect(mergeFailed(chain({ prs: [failed] }), failed, false)).toBe(false)
  })

  test("reviews, conflicts, and blocks are hard-blocked; pending is not", () => {
    expect(mergeFailed(chain({ prs: [pull({ reviewState: "changes_requested" })] }))).toBe(true)
    expect(mergeFailed(chain({ prs: [pull({ mergeState: "conflict" })] }))).toBe(true)
    expect(mergeFailed(chain({ prs: [pull({ mergeState: "blocked" })] }))).toBe(true)
    expect(mergeFailed(chain({ prs: [pull({ mergeState: "pending" })] }))).toBe(false)
  })

  test("ready, missing, and non-open PRs never fail", () => {
    expect(mergeFailed(chain({ runs: [], prs: [pull({ mergeState: "ready" })] }))).toBe(false)
    expect(mergeFailed(chain({ prs: [] }))).toBe(false)
    expect(mergeFailed(chain({ prs: [pull({ state: "merged" })] }))).toBe(false)
    expect(mergeFailed(chain({ prs: [pull({ state: "closed", mergeState: "blocked" })] }))).toBe(false)
  })

  test("other heads, repos, and superseded runs do not fail this PR", () => {
    const otherHead = run("failed")
    otherHead.headSha = "other-head"
    expect(mergeFailed(chain({ runs: [otherHead] }))).toBe(false)
    const otherRepo = { ...run("failed"), repo: { host: "github.com", owner: "other", repo: "repo" } }
    expect(mergeFailed(chain({ runs: [otherRepo] }))).toBe(false)
    const superseded = { ...run("cancelled"), series: { key: "ci", sequence: 1 } }
    const latest = { ...run("succeeded"), series: { key: "ci", sequence: 2 } }
    expect(mergeFailed(chain({ runs: [superseded, latest] }))).toBe(false)
  })

  test("a blocked member fails without failing its lead", () => {
    const lead = pull({ number: 1 })
    const blocked = pull({ number: 2, mergeState: "blocked" })
    const grouped = chain({ prs: [lead, blocked] })
    expect(mergeFailed(grouped, blocked)).toBe(true)
    expect(mergeFailed(grouped, lead)).toBe(false)
  })
})

describe("pendingReviewNotice", () => {
  test("names the approval gap only when reviews exist without a decision", () => {
    expect(pendingReviewNotice(pull({ reviewState: "pending" }))).toBe("reviews are pending (no approval on record)")
    expect(pendingReviewNotice(pull({ reviewState: "approved" }))).toBeUndefined()
    expect(pendingReviewNotice(pull({ reviewState: "changes_requested" }))).toBeUndefined()
    expect(pendingReviewNotice(pull({ reviewState: null }))).toBeUndefined()
    expect(pendingReviewNotice(pull({ reviewState: undefined }))).toBeUndefined()
  })
})

describe("chainTone", () => {
  test("failures, conflicts, blocked merges, and change requests are danger", () => {
    expect(chainTone(chain({ runs: [run("failed")] }))).toBe("danger")
    expect(chainTone(chain({ prs: [pull({ mergeState: "conflict" })] }))).toBe("danger")
    expect(chainTone(chain({ prs: [pull({ mergeState: "blocked" })] }))).toBe("danger")
    expect(chainTone(chain({ prs: [pull({ reviewState: "changes_requested" })] }))).toBe("danger")
  })

  test("historical runs neither block the tone nor fabricate success", () => {
    const staleFailedRun = { ...run("failed"), headSha: "previous-head" }
    const staleQueuedRun = { ...run("queued"), headSha: "previous-head" }
    // No current-head evidence and no merge state: calm/unknown — historical
    // runs read as neither danger/warning nor a green chain (no evidence, no merge).
    expect(chainTone(chain({ runs: [staleFailedRun] }))).toBeUndefined()
    expect(chainTone(chain({ runs: [staleQueuedRun] }))).toBeUndefined()
    expect(chainTone(chain({ runs: [run("failed")] }))).toBe("danger")
    expect(chainTone(chain({ runs: [run("running")] }))).toBe("warning")
  })

  test("in-flight work and pending merges are warning", () => {
    expect(chainTone(chain({ runs: [run("running")] }))).toBe("warning")
    expect(chainTone(chain({ prs: [pull({ mergeState: "pending" })] }))).toBe("warning")
  })

  test("blocked is danger even while checks run, but only for open PRs", () => {
    expect(chainTone(chain({ prs: [pull({ mergeState: "blocked" })], runs: [] }))).toBe("danger")
    expect(chainTone(chain({ prs: [pull({ mergeState: "blocked" })], runs: [run("running")] }))).toBe("danger")
    expect(chainTone(chain({ prs: [pull({ state: "draft", mergeState: "blocked" })] }))).toBeUndefined()
    expect(chainTone(chain({ prs: [pull({ state: "closed", mergeState: "blocked" })] }))).toBeUndefined()
    expect(chainTone(chain({ prs: [pull({ state: "merged", mergeState: "blocked" })] }))).toBe("success")
  })

  test("a fully green open chain and a merged PR are success", () => {
    expect(chainTone(chain({ prs: [pull({ mergeState: "ready", reviewState: "approved" })] }))).toBe("success")
    expect(chainTone(chain({ prs: [pull({ state: "merged" })] }))).toBe("success")
  })

  test("superseded failures do not keep the latest workflow series red", () => {
    const supersededFailure = { ...run("failed"), id: 70, series: { key: "workflow-1", sequence: 70 } }
    const latestSuccess = { ...run("succeeded"), id: 71, series: { key: "workflow-1", sequence: 71 } }
    const current = chain({ runs: [supersededFailure, latestSuccess] })
    expect(chainTone(current)).toBe("success")
    expect(pillPick([current])?.reason).toBe("newest")
  })

  test("status-check policy controls green tone without hiding actual danger", () => {
    const waiting = chain({ prs: [pull({ statusChecks: { headSha: "abc123", state: "available", contexts: [{ name: "gate", status: "running" }] } })] })
    expect(chainTone(waiting)).toBeUndefined()
    expect(chainTone(waiting, false)).toBe("success")
    expect(pillPick([waiting])?.reason).toBe("newest")
    expect(pillPick([waiting], false)?.reason).toBe("newest")

    const danger = chain({ prs: [pull({ reviewState: "changes_requested", statusChecks: { headSha: "abc123", state: "available", contexts: [{ name: "gate", status: "running" }] } })] })
    expect(chainTone(danger, false)).toBe("danger")
    expect(pillPick([waiting, danger], false)?.chain).toBe(danger)
  })

  test("chain tone evaluates the open PR even when a merged PR leads the group", () => {
    const merged = pull({ state: "merged", number: 1, headSha: "merged-head" })
    const open = pull({ state: "open", number: 2, headSha: "open-head" })
    const failureOnMergedHead = { ...run("failed"), headSha: "merged-head" }
    const currentSuccess = { ...run("succeeded"), headSha: "open-head" }
    expect(chainTone(chain({ prs: [merged, open], runs: [failureOnMergedHead, currentSuccess] }))).toBe("success")
  })

  test("issues alone carry no tone until open", () => {
    expect(chainTone(chain({ prs: [], issues: [issue("closed")], runs: [] }))).toBeUndefined()
    expect(chainTone(chain({ prs: [], issues: [issue("open")], runs: [] }))).toBeUndefined()
  })
})

describe("pullForRun", () => {
  test("prefers explicit PR metadata, then SHA, then a unique branch", () => {
    const bySha = pull({ number: 1, headSha: "sha-1", headBranch: "same" })
    const byMetadata = pull({ number: 2, headSha: "sha-2", headBranch: "same" })
    const explicitRun = { ...run("succeeded"), headSha: "other", headBranch: "same", pullRequests: [2] }
    expect(pullForRun(explicitRun, [bySha, byMetadata])).toBe(byMetadata)

    const shaRun = { ...run("succeeded"), headSha: "sha-1", headBranch: "same", pullRequests: [] }
    expect(pullForRun(shaRun, [bySha, byMetadata])).toBe(bySha)

    const branchRun = { ...run("succeeded"), headSha: "other", headBranch: "unique", pullRequests: [] }
    const unique = pull({ number: 3, headBranch: "unique" })
    expect(pullForRun(branchRun, [unique])).toBe(unique)
  })

  test("retains every explicit PR association and shared head SHA", () => {
    const first = pull({ number: 1, headSha: "shared" })
    const second = pull({ number: 2, headSha: "shared" })
    const explicitRun = { ...run("failed"), pullRequests: [1, 2] }
    const shaRun = { ...run("failed"), headSha: "shared", pullRequests: [] }
    expect(pullsForRun(explicitRun, [first, second])).toEqual([first, second])
    expect(pullsForRun(shaRun, [first, second])).toEqual([first, second])
  })

  test("does not guess when branch-only association is ambiguous or metadata is unmatched", () => {
    const first = pull({ number: 1, headSha: "sha-1", headBranch: "same" })
    const second = pull({ number: 2, headSha: "sha-2", headBranch: "same" })
    const ambiguousRun = { ...run("succeeded"), headSha: "other", headBranch: "same", pullRequests: [] }
    expect(pullForRun(ambiguousRun, [first, second])).toBeUndefined()

    const unmatchedMetadata = { ...ambiguousRun, pullRequests: [99], headSha: "sha-1" }
    expect(pullForRun(unmatchedMetadata, [first, second])).toBeUndefined()
  })
})

describe("armedTargets", () => {
  const entry = (over: Partial<ArmedEntry> = {}): ArmedEntry => ({
    repo,
    number: 4821,
    method: "squash",
    ...over,
  })

  test("a green chain with a matching entry fires with its armed method", () => {
    const targets = armedTargets([entry({ method: "rebase" })], [chain({ prs: [pull({ mergeState: "ready" })] })])
    expect(targets).toEqual([{ pull: pull({ mergeState: "ready" }), chain: chain({ prs: [pull({ mergeState: "ready" })] }), method: "rebase" }])
  })

  test("default-on status waiting blocks armed dispatch until passed; opting out restores eligibility", () => {
    const pending = chain({ prs: [pull({ statusChecks: { headSha: "abc123", state: "available", contexts: [{ name: "fresnel/renovate-ci", status: "running" }] } })] })
    expect(armedTargets([entry()], [pending])).toEqual([])
    expect(armedTargets([entry()], [pending], false).length).toBe(1)
  })

  test("readiness is checked for the armed PR, not another PR leading its chain", () => {
    const lead = pull({ number: 1, mergeState: "blocked" })
    const target = pull({ number: 4821, mergeState: "ready" })
    const grouped = chain({ prs: [lead, target] })
    expect(armedTargets([entry()], [grouped])).toEqual([{ pull: target, chain: grouped, method: "squash" }])
  })

  test("blocked, conflicted and failing chains don't fire yet", () => {
    const blocked = chain({ prs: [pull({ mergeState: "blocked" })] })
    const conflicted = chain({ prs: [pull({ mergeState: "conflict" })] })
    const failing = chain({ runs: [run("failed")] })
    expect(armedTargets([entry()], [blocked, conflicted, failing])).toEqual([])
  })

  test("entries only match their own repo, number, and open PRs", () => {
    const otherRepo = entry({ repo: { host: "github.com", owner: "sst", repo: "ui" } })
    const otherNumber = entry({ number: 9999 })
    const merged = chain({ prs: [pull({ state: "merged" })] })
    expect(armedTargets([otherRepo], [chain()])).toEqual([])
    expect(armedTargets([otherNumber], [chain()])).toEqual([])
    expect(armedTargets([entry()], [merged])).toEqual([])
  })

  test("providers without merge state still fire on green checks alone", () => {
    // mergeState undefined: the fallback path — what a minimal forge returns.
    expect(armedTargets([entry()], [chain()]).length).toBe(1)
  })
})

describe("staleHeadRetryEligible", () => {
  const ready = {
    via: "when-ready" as const,
    headChanged: true,
    armed: true,
    refreshSucceeded: true,
    inFlight: false,
    rejectedHeadSha: "old-head",
    currentHeadSha: "new-head",
    ready: true,
  }

  test("retries only an armed, refreshed, newly changed head that is ready", () => {
    expect(staleHeadRetryEligible(ready)).toBe(true)
    expect(staleHeadRetryEligible({ ...ready, via: "manual" })).toBe(false)
    expect(staleHeadRetryEligible({ ...ready, headChanged: false })).toBe(false)
    expect(staleHeadRetryEligible({ ...ready, armed: false })).toBe(false)
    expect(staleHeadRetryEligible({ ...ready, refreshSucceeded: false })).toBe(false)
    expect(staleHeadRetryEligible({ ...ready, inFlight: true })).toBe(false)
    expect(staleHeadRetryEligible({ ...ready, currentHeadSha: "old-head" })).toBe(false)
    expect(staleHeadRetryEligible({ ...ready, currentHeadSha: undefined })).toBe(false)
    expect(staleHeadRetryEligible({ ...ready, ready: false })).toBe(false)
  })
})

describe("sessionAttemptCurrent", () => {
  test("rejects completions from a replaced session or directory", () => {
    const original = { id: "session-a", directory: "/repo/a" }
    expect(sessionAttemptCurrent(original, original)).toBe(true)
    expect(sessionAttemptCurrent(original, { ...original, id: "session-b" })).toBe(false)
    expect(sessionAttemptCurrent(original, { ...original, directory: "/repo/b" })).toBe(false)
    expect(sessionAttemptCurrent(original, undefined)).toBe(false)
  })
})

describe("targetRefreshConfirmed", () => {
  test("publishes no evidence after any stage fails, even if hydrate returned the PR", () => {
    expect(targetRefreshConfirmed({ refreshSucceeded: true, targetReturned: true, targetUnresolved: false })).toBe(true)
    expect(targetRefreshConfirmed({ refreshSucceeded: true, targetReturned: false, targetUnresolved: false })).toBe(false)
    // Hydration may succeed, but a later branch-run stage can fail; do not publish it.
    expect(targetRefreshConfirmed({ refreshSucceeded: false, targetReturned: true, targetUnresolved: false })).toBe(false)
    expect(targetRefreshConfirmed({ refreshSucceeded: true, targetReturned: false, targetUnresolved: true })).toBe(false)
  })
})

describe("staleHeadEvidenceUsable", () => {
  test("requires a confirmed refreshed head different from the rejected head and candidate", () => {
    expect(staleHeadEvidenceUsable({ rejectedHeadSha: "old", candidateHeadSha: "new", confirmedHeadSha: "new" })).toBe(true)
    expect(staleHeadEvidenceUsable({ rejectedHeadSha: "old", candidateHeadSha: "old", confirmedHeadSha: "old" })).toBe(false)
    expect(staleHeadEvidenceUsable({ rejectedHeadSha: "old", candidateHeadSha: "new", confirmedHeadSha: "other" })).toBe(false)
    expect(staleHeadEvidenceUsable({ rejectedHeadSha: "old", candidateHeadSha: "new" })).toBe(false)
  })
})

describe("pillPick", () => {
  test("a danger chain outranks a calm newer one", () => {
    const calm = chain({ key: "calm", updatedAt: 200, prs: [pull({ number: 100, mergeState: "ready" })] })
    const danger = chain({ key: "danger", updatedAt: 100, prs: [pull({ number: 101, reviewState: "changes_requested" })] })
    const picked = pillPick([calm, danger])
    expect(picked?.reason).toBe("danger")
    expect(picked?.chain.key).toBe("danger")
    expect(picked?.considered).toBe(2)
  })

  test("an older blocked chain outranks a calm newer chain", () => {
    const calm = chain({ key: "calm", updatedAt: 200, prs: [pull({ number: 100, mergeState: "ready" })] })
    const blocked = chain({ key: "blocked", updatedAt: 100, prs: [pull({ number: 101, mergeState: "blocked" })] })
    const picked = pillPick([calm, blocked])
    expect(picked?.reason).toBe("danger")
    expect(picked?.chain.key).toBe("blocked")
  })

  test("otherwise the most recently updated PR chain wins", () => {
    const older = chain({ key: "older", updatedAt: 100 })
    const newer = chain({ key: "newer", updatedAt: 200 })
    const picked = pillPick([older, newer])
    expect(picked?.reason).toBe("newest")
    expect(picked?.chain.key).toBe("newer")
  })

  test("merged PR chains never win ahead of a live PR", () => {
    const merged = chain({ key: "merged", updatedAt: 300, prs: [pull({ state: "merged", number: 1 })] })
    const live = chain({ key: "live", updatedAt: 100, prs: [pull({ state: "open", number: 2 })] })
    const picked = pillPick([merged, live])
    expect(picked?.chain.key).toBe("live")
    expect(picked?.considered).toBe(1)
  })

  test("a sole merged PR remains available as the terminal pill", () => {
    const merged = chain({ key: "merged", prs: [pull({ state: "merged", number: 1 })], runs: [] })
    expect(pillPick([merged])).toEqual({ chain: merged, reason: "merged", considered: 1 })
  })

  test("run-only chains are the last resort", () => {
    const runOnly = chain({ key: "run", prs: [], runs: [run("succeeded")] })
    const picked = pillPick([runOnly])
    expect(picked?.reason).toBe("runs-only")
    expect(picked?.chain.key).toBe("run")
  })

  test("issue-only chains do not win when the pill has nothing to show", () => {
    const issueOnly = chain({ key: "issue", prs: [], runs: [], issues: [issue("open")] })
    expect(pillPick([issueOnly])).toBeUndefined()
  })

  test("the runs-only fallback ignores issue-only chains and picks the newest run chain", () => {
    const stale = chain({ key: "stale", prs: [], runs: [run("failed")], updatedAt: 100 })
    const issueOnly = chain({ key: "issue", prs: [], runs: [], issues: [issue("open")], updatedAt: 500 })
    const fresh = chain({ key: "fresh", prs: [], runs: [run("running")], updatedAt: 300 })
    const picked = pillPick([stale, issueOnly, fresh])
    expect(picked?.reason).toBe("runs-only")
    expect(picked?.chain.key).toBe("fresh")
    expect(picked?.considered).toBe(2)
  })

  test("the merged pool outranks settled run-only chains; issue-only never wins", () => {
    const merged = chain({ key: "merged", prs: [pull({ state: "merged" })], runs: [], updatedAt: 500 })
    const issueOnly = chain({ key: "issue", prs: [], runs: [], issues: [issue("open")], updatedAt: 600 })
    const settled = chain({ key: "run", prs: [], runs: [run("succeeded")], updatedAt: 100 })
    expect(pillPick([merged, issueOnly, settled])?.chain.key).toBe("merged")
  })

  test("integration (eligible → pick): a failing run-only chain never pills on its own", () => {
    const merged = chain({
      key: "merged",
      updatedAt: 300,
      prs: [pull({ state: "merged", number: 1, headBranch: "feat/thing" })],
      runs: [run("succeeded")],
    })
    const failing = chain({ key: "failing", updatedAt: 100, prs: [], runs: [run("failed")] })
    const eligible = [merged, failing].filter((candidate) => pillEligible(candidate, { sessionBranch: "feat/thing", sessionRepo: repo }))
    expect(eligible.map((candidate) => candidate.key)).toEqual(["merged"])
    const picked = pillPick(eligible)
    expect(picked?.chain.key).toBe("merged")
    expect(picked?.reason).toBe("merged")
  })

  test("integration (eligible → pick): the newest merged chain is the terminal pill when several are eligible", () => {
    const older = chain({ key: "older", updatedAt: 100, prs: [pull({ state: "merged", number: 1, headBranch: "feat/thing" })], runs: [] })
    const newer = chain({ key: "newer", updatedAt: 300, prs: [pull({ state: "merged", number: 2, headBranch: "feat/thing" })], runs: [] })
    const eligible = [older, newer].filter((candidate) => pillEligible(candidate, { sessionBranch: "feat/thing", sessionRepo: repo }))
    const picked = pillPick(eligible)
    expect(picked?.chain.key).toBe("newer")
    expect(picked?.reason).toBe("merged")
    expect(picked?.considered).toBe(2)
  })

  test("integration (eligible → pick): a newer open PR outranks the session's merged one", () => {
    const merged = chain({ key: "merged", updatedAt: 500, prs: [pull({ state: "merged", number: 1, headBranch: "feat/thing" })], runs: [] })
    const open = chain({ key: "open", updatedAt: 300, prs: [pull({ state: "open", number: 2, headBranch: "feat/thing" })], runs: [] })
    const eligible = [merged, open].filter((candidate) => pillEligible(candidate, { sessionBranch: "feat/thing", sessionRepo: repo }))
    expect(pillPick(eligible)?.chain.key).toBe("open")
  })

  test("no chains, no pill", () => {
    expect(pillPick([])).toBeUndefined()
  })
})

describe("pillPicks", () => {
  test("first pick matches pillPick, then lists every eligible chain in priority order", () => {
    const calm = chain({ key: "calm", updatedAt: 200, prs: [pull({ number: 100, mergeState: "ready" })] })
    const danger = chain({ key: "danger", updatedAt: 100, prs: [pull({ number: 101, reviewState: "changes_requested" })] })
    const picks = pillPicks([calm, danger])
    expect(picks.map((p) => p.chain.key)).toEqual(["danger", "calm"])
    expect(picks[0]?.reason).toBe("danger")
    expect(picks[1]?.reason).toBe("newest")
    expect(pillPick([calm, danger])?.chain.key).toBe(picks[0]?.chain.key)
  })

  test("danger chains sort newest-first among themselves, then calm chains newest-first", () => {
    const oldDanger = chain({ key: "old-danger", updatedAt: 100, prs: [pull({ number: 1, mergeState: "blocked" })] })
    const newDanger = chain({ key: "new-danger", updatedAt: 150, prs: [pull({ number: 2, mergeState: "conflict" })] })
    const newCalm = chain({ key: "new-calm", updatedAt: 300, prs: [pull({ number: 3, mergeState: "ready" })] })
    const picks = pillPicks([newCalm, oldDanger, newDanger])
    expect(picks.map((p) => p.chain.key)).toEqual(["new-danger", "old-danger", "new-calm"])
  })

  test("open PRs outrank attention run-only, merged, and settled runs; issue-only never pills", () => {
    const open = chain({ key: "open", updatedAt: 100, prs: [pull({ number: 1 })] })
    const attention = chain({ key: "attention", updatedAt: 500, prs: [], runs: [run("failed")] })
    const merged = chain({ key: "merged", updatedAt: 400, prs: [pull({ number: 2, state: "merged" })], runs: [] })
    const settled = chain({ key: "settled", updatedAt: 450, prs: [], runs: [run("succeeded")] })
    const issueOnly = chain({ key: "issue", updatedAt: 600, prs: [], runs: [], issues: [issue("open")] })
    const picks = pillPicks([settled, merged, attention, issueOnly, open])
    expect(picks.map((p) => p.chain.key)).toEqual(["open", "attention", "merged", "settled"])
    expect(picks.map((p) => p.reason)).toEqual(["newest", "runs-only", "merged", "runs-only"])
  })

  test("no chains, no pills", () => {
    expect(pillPicks([])).toEqual([])
  })
})

describe("pillEligible", () => {
  const own = "feat/thing"
  const elsewhere = "fix/other-session"
  const branched = (headBranch: string, over: Partial<PullEntity> = {}): Chain =>
    chain({ prs: [pull({ headBranch, ...over })] })
  const ctx = (over: { sessionBranch?: string; sessionRepo?: RepoRef; sessionHeadSha?: string; created?: ReadonlySet<string> } = {}) => ({
    sessionBranch: own,
    sessionRepo: repo,
    ...over,
  })

  test("the session's own PR is eligible while open or in draft", () => {
    expect(pillEligible(branched(own), ctx())).toBe(true)
    expect(pillEligible(branched(own, { state: "draft" }), ctx())).toBe(true)
  })

  test("the session's own PR stays eligible after merging — the pill is the session's work", () => {
    expect(pillEligible(branched(own, { state: "merged" }), ctx())).toBe(true)
  })

  test("a closed-without-merge own PR drops out", () => {
    expect(pillEligible(branched(own, { state: "closed" }), ctx())).toBe(false)
  })

  test("other branches' PRs never pill, open or merged — mention is not intent", () => {
    expect(pillEligible(branched(elsewhere), ctx())).toBe(false)
    expect(pillEligible(branched(elsewhere, { state: "merged" }), ctx())).toBe(false)
  })

  test("a foreign repo's PR on a coincidentally identical branch name never pills", () => {
    // The PR #5 incident itself was cross-repo: two agents can both cut
    // `feat/thing`, and a mention-recruited foreign PR must not pass the
    // branch rule — repo scoping is what makes it "the session's own work".
    const foreign = { host: "github.com", owner: "other", repo: "repo" }
    expect(pillEligible(branched(own, { repo: foreign }), ctx())).toBe(false)
    expect(pillEligible(branched(own, { repo: foreign, state: "merged" }), ctx())).toBe(false)
  })

  test("CI needing attention alone never pills — only session-created PRs pill", () => {
    const open = { prs: [pull({ headBranch: elsewhere })] }
    expect(pillEligible(chain({ ...open, runs: [run("queued")] }), ctx())).toBe(false)
    expect(pillEligible(chain({ ...open, runs: [run("running")] }), ctx())).toBe(false)
    expect(pillEligible(chain({ ...open, runs: [run("failed")] }), ctx())).toBe(false)
    expect(pillEligible(chain({ ...open, runs: [run("cancelled")] }), ctx())).toBe(false)
    // A closed PR's runs are history — same head, so only `state: "closed"`
    // can carry this assertion.
    const closed = { prs: [pull({ headBranch: elsewhere, state: "closed" })] }
    expect(pillEligible(chain({ ...closed, runs: [run("failed")] }), ctx())).toBe(false)
    // Run-only chains never pill on their own, even on a discovered failure.
    expect(pillEligible(chain({ prs: [], runs: [run("failed")] }), ctx())).toBe(false)
  })

  test("superseded workflow runs never pill on their own", () => {
    const oldFailure = { ...run("failed"), id: 80, series: { key: "workflow-1", sequence: 80 } }
    const latestSuccess = { ...run("succeeded"), id: 81, series: { key: "workflow-1", sequence: 81 } }
    expect(pillEligible(branched(elsewhere), ctx())).toBe(false)
    expect(pillEligible(chain({ prs: [pull({ headBranch: elsewhere })], runs: [oldFailure, latestSuccess] }), ctx())).toBe(false)
  })

  test("arming another branch's PR never pills it — arming is not creation", () => {
    const multi = chain({ prs: [pull({ headBranch: elsewhere, number: 1 }), pull({ headBranch: elsewhere, number: 2 })] })
    expect(pillEligible(multi, ctx())).toBe(false)
    // Same number, different repository: repo scoping still holds.
    const otherRepo = { host: "github.com", owner: "other", repo: "repo" }
    expect(pillEligible(chain({ prs: [pull({ headBranch: elsewhere, number: 1, repo: otherRepo })] }), ctx())).toBe(false)
  })

  test("issue-only chains and settled run-only chains stay in the sidebar", () => {
    expect(pillEligible(chain({ prs: [], runs: [], issues: [issue("open")] }), ctx())).toBe(false)
    expect(pillEligible(chain({ prs: [], runs: [run("succeeded")] }), ctx())).toBe(false)
  })

  test("a push from any local branch counts as own work via HEAD-SHA match", () => {
    const pushed = chain({ prs: [pull({ headBranch: elsewhere, headSha: "dd18b294" })] })
    expect(pillEligible(pushed, ctx({ sessionHeadSha: "dd18b294" }))).toBe(true)
    expect(pillEligible(pushed, ctx({ sessionHeadSha: "other-sha" }))).toBe(false)
    // Closed-without-merge still drops out, and the match stays repo-scoped.
    expect(pillEligible(chain({ prs: [pull({ headBranch: elsewhere, headSha: "dd18b294", state: "closed" })] }), ctx({ sessionHeadSha: "dd18b294" }))).toBe(false)
    const foreign = { host: "github.com", owner: "other", repo: "repo" }
    expect(pillEligible(chain({ prs: [pull({ headBranch: elsewhere, headSha: "dd18b294", repo: foreign })] }), ctx({ sessionHeadSha: "dd18b294" }))).toBe(false)
  })

  test("without a session branch, only HEAD-SHA or created memory pills", () => {
    const bare = { sessionBranch: undefined }
    expect(pillEligible(branched(own), bare)).toBe(false)
    expect(pillEligible(chain({ runs: [run("failed")] }), bare)).toBe(false)
    expect(pillEligible(branched(elsewhere), bare)).toBe(false)
    const shaOwned = chain({ prs: [pull({ headBranch: elsewhere, headSha: "dd18b294" })] })
    expect(pillEligible(shaOwned, { sessionRepo: repo, sessionBranch: undefined, sessionHeadSha: "dd18b294" })).toBe(true)
  })

  test("sticky created memory keeps prior own-work PRs after the checkout moves on", () => {
    const first = pull({ headBranch: elsewhere, number: 7, state: "open" })
    const created = new Set([entityKey(first)])
    // No live branch/SHA match anymore, but the session created it: still pills.
    expect(pillEligible(chain({ prs: [first], runs: [], updatedAt: 0 }), ctx({ created }))).toBe(true)
    // Closed-without-merge still drops out even when remembered.
    const closed = pull({ headBranch: elsewhere, number: 7, state: "closed" })
    expect(pillEligible(chain({ prs: [closed], runs: [], updatedAt: 0 }), ctx({ created }))).toBe(false)
    // Keys are repo-scoped: a same-number foreign PR never rides along.
    const foreign = pull({ headBranch: elsewhere, number: 7, state: "open", repo: { host: "github.com", owner: "other", repo: "repo" } })
    expect(pillEligible(chain({ prs: [foreign], runs: [], updatedAt: 0 }), ctx({ created }))).toBe(false)
  })

  test("regression (PR #5 recruiting incident): a transcript-recruited cross-branch chain forms but never pills", () => {
    // The session on `feat/thing` mentioned another session's PR in bare and
    // kind-word form ("maybe #5 exists", "PR 5 fixed it"). Extraction made both
    // candidates, hydration recruited the PR, associate chained it — and the
    // pill must still not show it.
    const other = { host: "github.com", owner: "esafak", repo: "muninn" }
    const recruited = pull({ repo: other, number: 5, headBranch: elsewhere, state: "open" })
    const chains = associate([recruited], [], own)
    expect(chains.length).toBe(1)
    const eligible = chains.filter((candidate) =>
      pillEligible(candidate, { sessionBranch: own, sessionRepo: repo }),
    )
    expect(eligible).toEqual([])
  })
})

describe("pillLeadOf", () => {
  test("prefers the open PR, falling back to merged only for merged/pinned picks", () => {
    const open = pull({ number: 1, state: "open" })
    const merged = pull({ number: 2, state: "merged" })
    const grouped = chain({ prs: [merged, open] })
    expect(pillLeadOf(grouped, "newest")).toBe(open)
    expect(pillLeadOf(grouped, "danger")).toBe(open)
    expect(pillLeadOf(chain({ prs: [merged] }), "merged")).toBe(merged)
    expect(pillLeadOf(chain({ prs: [merged] }), "pinned")).toBe(merged)
    expect(pillLeadOf(chain({ prs: [merged] }), "newest")).toBeUndefined()
    expect(pillLeadOf(chain({ prs: [merged] }), "danger")).toBeUndefined()
  })

  test("draft counts as a lead; pinned falls back to prs[0], others stay empty", () => {
    const draft = pull({ number: 3, state: "draft" })
    expect(pillLeadOf(chain({ prs: [draft] }), "newest")).toBe(draft)
    const closed = pull({ state: "closed" })
    expect(pillLeadOf(chain({ prs: [closed] }), "pinned")).toBe(closed)
    expect(pillLeadOf(chain({ prs: [closed] }), "newest")).toBeUndefined()
  })
})

describe("pillHeadIdentity", () => {
  test("names PR leads, then issues, then runs, then the chain key", () => {
    expect(pillHeadIdentity(chain({ key: "k", prs: [pull({ number: 7, title: "feat: thing" })] }), "newest")).toBe("#7 feat: thing")
    expect(pillHeadIdentity(chain({ key: "k", prs: [], issues: [issue("open")] }), "pinned")).toBe("#1043 bug: thing")
    const runChain = chain({ key: "k", prs: [], runs: [{ ...run("failed"), id: 99 }] })
    expect(pillHeadIdentity(runChain, "pinned")).toBe("run #99")
    expect(pillHeadIdentity(chain({ key: "lonely", prs: [], runs: [], issues: [] }), "pinned")).toBe("lonely")
  })
})

describe("rememberCreated", () => {
  test("accumulates owned keys per session without touching other sessions", () => {
    const a = "sA\n/dir-a"
    const b = "sB\n/dir-b"
    const first = rememberCreated(new Map(), a, ["github.com/sst/opencode#pr1"])
    expect(first.get(a)).toEqual(new Set(["github.com/sst/opencode#pr1"]))
    const second = rememberCreated(first, b, ["github.com/sst/opencode#pr2"])
    expect(second.get(a)).toEqual(new Set(["github.com/sst/opencode#pr1"]))
    expect(second.get(b)).toEqual(new Set(["github.com/sst/opencode#pr2"]))
    // No new keys: referential stability, so memos never recompute.
    expect(rememberCreated(second, b, ["github.com/sst/opencode#pr2"])).toBe(second)
    expect(rememberCreated(second, "sC\n/dir-c", [])).toBe(second)
  })

  test("evicts the least-recently-created session past the cap, never the writer", () => {
    let map: ReadonlyMap<string, ReadonlySet<string>> = new Map()
    map = rememberCreated(map, "s1\n/d1", ["k1"], 2)
    map = rememberCreated(map, "s2\n/d2", ["k2"], 2)
    map = rememberCreated(map, "s3\n/d3", ["k3"], 2)
    expect([...map.keys()]).toEqual(["s2\n/d2", "s3\n/d3"])
    // Re-touching the evicted session re-creates it, evicting the next oldest.
    map = rememberCreated(map, "s1\n/d1", ["k1"], 2)
    expect([...map.keys()]).toEqual(["s3\n/d3", "s1\n/d1"])
  })
})

describe("isFreshBaseSession", () => {
  test("fresh on base with zero refs, not fresh otherwise", () => {
    expect(isFreshBaseSession("main", 0)).toBe(true)
    expect(isFreshBaseSession("master", 0)).toBe(true)
    expect(isFreshBaseSession("main", 1)).toBe(false)
    expect(isFreshBaseSession("feat/thing", 0)).toBe(false)
    expect(isFreshBaseSession("", 0)).toBe(false)
    expect(isFreshBaseSession("Main", 0)).toBe(false)
  })
})

describe("jsonReady", () => {
  test("removes properties whose value is undefined, at any depth", () => {
    const input: Record<string, unknown> = { kind: "pr", mergedAt: undefined, repo: { host: "github.com", owner: undefined, repo: "x" } }
    expect(jsonReady(input)).toEqual({ kind: "pr", repo: { host: "github.com", repo: "x" } })
  })

  test("preserves JSON values that merely look falsy", () => {
    const kept = jsonReady({ a: null, b: 0, c: false, d: "", e: [], items: [{ f: null }] })
    expect(kept).toEqual({ a: null, b: 0, c: false, d: "", e: [], items: [{ f: null }] })
  })

  test("passes primitives through", () => {
    expect(jsonReady("x")).toBe("x")
    expect(jsonReady(0)).toBe(0)
    expect(jsonReady(null)).toBe(null)
  })
})

describe("pinnedChain", () => {
  test("resolves pull identity across lead changes and chain keys for groups", async () => {
    const mod = await import("./model")
    const repoA = { host: "github.com", owner: "sst", repo: "opencode" }
    const mkChain = (n: number, state: "open" | "merged" = "open"): import("./model").Chain => ({
      key: `github.com/sst/opencode#pr${n}`,
      prs: [pull({ repo: repoA, number: n, state })],
      issues: [],
      runs: [],
      updatedAt: n,
    })
    const chains = [mkChain(1), mkChain(2)]
    expect(mod.pinnedChain(chains, { repo: repoA, number: 2 })?.key).toBe(chains[1]!.key)
    expect(mod.pinnedChain(chains, { key: chains[0]!.key })?.key).toBe(chains[0]!.key)
    expect(mod.pinnedChain(chains, {})).toBeUndefined()
    expect(mod.pinnedChain(chains, { repo: repoA, number: 9 })).toBeUndefined()
    expect(mod.samePin({ repo: repoA, number: 2 }, { repo: repoA, number: 2 })).toBe(true)
    expect(mod.samePin(mod.pinForChain(chains[0]!), { repo: repoA, number: 1 })).toBe(true)
  })

  test("issue and run pins resolve by member identity, kinds never collide", async () => {
    const mod = await import("./model")
    const repoA = { host: "github.com", owner: "sst", repo: "opencode" }
    const issueChain: import("./model").Chain = {
      key: "github.com/sst/opencode#issue42",
      prs: [],
      issues: [{ kind: "issue", provider: "github", repo: repoA, number: 42, title: "t", state: "open", url: "u", updatedAt: 1 }],
      runs: [],
      updatedAt: 1,
    }
    const runChain: import("./model").Chain = {
      key: JSON.stringify(["run-series", "github.com/sst/opencode", "abc", "ci"]),
      prs: [],
      issues: [],
      runs: [{ kind: "run", provider: "github", repo: repoA, id: 42, name: "ci", headBranch: "b", headSha: "abc", series: { key: "ci", sequence: 1 }, status: "failed", checks: [], pullRequests: [], url: "u", updatedAt: 2 }],
      updatedAt: 2,
    }
    const chains = [issueChain, runChain]
    expect(mod.pinForChain(issueChain)).toEqual({ repo: repoA, number: 42, kind: "issue" })
    expect(mod.pinForChain(runChain)).toEqual({ repo: repoA, number: 42, kind: "run" })
    // Same number, different kinds: never the same pin.
    expect(mod.samePin({ repo: repoA, number: 42, kind: "issue" }, { repo: repoA, number: 42, kind: "run" })).toBe(false)
    expect(mod.samePin({ repo: repoA, number: 42 }, { repo: repoA, number: 42, kind: "pr" })).toBe(true)
    expect(mod.pinnedChain(chains, { repo: repoA, number: 42, kind: "issue" })?.key).toBe(issueChain.key)
    expect(mod.pinnedChain(chains, { repo: repoA, number: 42, kind: "run" })?.key).toBe(runChain.key)
    expect(mod.pinnedChain(chains, { repo: repoA, number: 42 })?.key).toBeUndefined()
    expect(mod.pinnedChain(chains, { repo: repoA, number: 42, kind: "issue", owner: "other-session" })?.key).toBe(issueChain.key)
  })
})

describe("menuChains", () => {
  const keys = (chains: readonly Chain[]): string[] => chains.map((chain) => chain.key)
  const eligible = [chain({ key: "a" }), chain({ key: "b" }), chain({ key: "c" }), chain({ key: "d" })]

  test("no pin lists the first three eligible chains", () => {
    expect(keys(menuChains(undefined, eligible))).toEqual(["a", "b", "c"])
    expect(keys(menuChains({ chain: chain({ key: "a" }), reason: "newest" }, eligible))).toEqual(["a", "b", "c"])
    expect(keys(menuChains(undefined, [chain({ key: "a" })]))).toEqual(["a"])
  })

  test("an ineligible pin leads, filling the rest from eligible", () => {
    expect(keys(menuChains({ chain: chain({ key: "x" }), reason: "pinned" }, eligible))).toEqual(["x", "a", "b"])
  })

  test("an eligible pin past the cap still leads once, deduplicated", () => {
    expect(keys(menuChains({ chain: chain({ key: "d" }), reason: "pinned" }, eligible))).toEqual(["d", "a", "b"])
    expect(keys(menuChains({ chain: chain({ key: "b" }), reason: "pinned" }, eligible))).toEqual(["b", "a", "c"])
  })
})
