import { describe, expect, test } from "bun:test"
import type { Chain, IssueEntity, PullEntity, RunEntity } from "./model"
import { chainTone, mergeReady, mergeWhy, armedTargets, pillPick, type ArmedEntry, pillEligible, pullForRun, pullsForRun } from "./model"
import { associate } from "./associate"

const repo = { host: "github.com", owner: "sst", repo: "opencode" }

const pull = (over: Partial<PullEntity> = {}): PullEntity => ({
  kind: "pr",
  provider: "github",
  repo,
  number: 4821,
  title: "feat: thing",
  state: "open",
  headBranch: "feat/thing",
  baseBranch: "main",
  closes: [],
  headSha: "abc123",
  url: "https://github.com/sst/opencode/pull/4821",
  updatedAt: 0,
  ...over,
})

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
})

describe("chainTone", () => {
  test("failures and conflicts are danger; change requests too", () => {
    expect(chainTone(chain({ runs: [run("failed")] }))).toBe("danger")
    expect(chainTone(chain({ prs: [pull({ mergeState: "conflict" })] }))).toBe("danger")
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

  test("in-flight work and blocked merges are warning", () => {
    expect(chainTone(chain({ runs: [run("running")] }))).toBe("warning")
    expect(chainTone(chain({ prs: [pull({ mergeState: "blocked" })] }))).toBe("warning")
    expect(chainTone(chain({ prs: [pull({ mergeState: "pending" })] }))).toBe("warning")
  })

  test("a fully green open chain and a merged PR are success", () => {
    expect(chainTone(chain({ prs: [pull({ mergeState: "ready", reviewState: "approved" })] }))).toBe("success")
    expect(chainTone(chain({ prs: [pull({ state: "merged" })] }))).toBe("success")
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

describe("pillPick", () => {
  test("a danger chain outranks a calm newer one", () => {
    const calm = chain({ key: "calm", updatedAt: 200, prs: [pull({ number: 100, mergeState: "ready" })] })
    const danger = chain({ key: "danger", updatedAt: 100, prs: [pull({ number: 101, reviewState: "changes_requested" })] })
    const picked = pillPick([calm, danger])
    expect(picked?.reason).toBe("danger")
    expect(picked?.chain.key).toBe("danger")
    expect(picked?.considered).toBe(2)
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

  test("run-only fallback skips merged PRs and issue-only chains", () => {
    const merged = chain({ key: "merged", prs: [pull({ state: "merged" })], runs: [], updatedAt: 500 })
    const issueOnly = chain({ key: "issue", prs: [], runs: [], issues: [issue("open")], updatedAt: 600 })
    const runOnly = chain({ key: "run", prs: [], runs: [run("succeeded")], updatedAt: 100 })
    expect(pillPick([merged, issueOnly, runOnly])?.chain.key).toBe("run")
  })

  test("no chains, no pill", () => {
    expect(pillPick([])).toBeUndefined()
  })
})

describe("pillEligible", () => {
  const own = "feat/thing"
  const elsewhere = "fix/other-session"
  const branched = (headBranch: string, over: Partial<PullEntity> = {}): Chain =>
    chain({ prs: [pull({ headBranch, ...over })] })
  const ctx = (over: { sessionBranch?: string; armedNumbers?: number[] } = {}) => ({ sessionBranch: own, ...over })

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

  test("CI needing attention makes any chain eligible — scoped to current heads", () => {
    const open = { prs: [pull({ headBranch: elsewhere })] }
    expect(pillEligible(chain({ ...open, runs: [run("queued")] }), ctx())).toBe(true)
    expect(pillEligible(chain({ ...open, runs: [run("running")] }), ctx())).toBe(true)
    expect(pillEligible(chain({ ...open, runs: [run("failed")] }), ctx())).toBe(true)
    expect(pillEligible(chain({ ...open, runs: [run("cancelled")] }), ctx())).toBe(false)
    // A closed PR's runs are history: a stale failure doesn't recruit the chain.
    const closed = { prs: [pull({ headBranch: elsewhere, state: "closed" })] }
    expect(pillEligible(chain({ ...closed, runs: [{ ...run("failed"), headSha: "older-head" }] }), ctx())).toBe(false)
    // Run-only chains have no head to be stale against: a discovered failure pills bare.
    expect(pillEligible(chain({ prs: [], runs: [run("failed")] }), ctx())).toBe(true)
  })

  test("an armed open PR is eligible, even non-lead and from another branch", () => {
    const multi = chain({ prs: [pull({ headBranch: elsewhere, number: 1 }), pull({ headBranch: elsewhere, number: 2 })] })
    expect(pillEligible(multi, ctx({ armedNumbers: [2] }))).toBe(true)
    expect(pillEligible(multi, ctx({ armedNumbers: [99] }))).toBe(false)
  })

  test("issue-only chains and settled run-only chains stay in the sidebar", () => {
    expect(pillEligible(chain({ prs: [], runs: [], issues: [issue("open")] }), ctx())).toBe(false)
    expect(pillEligible(chain({ prs: [], runs: [run("succeeded")] }), ctx())).toBe(false)
  })

  test("without a session branch, only the attention rules apply", () => {
    const attention = { armedNumbers: [], sessionBranch: undefined }
    expect(pillEligible(branched(own), attention)).toBe(false)
    expect(pillEligible(chain({ runs: [run("failed")] }), attention)).toBe(true)
    expect(pillEligible(branched(elsewhere), { armedNumbers: [4821], sessionBranch: undefined })).toBe(true)
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
    const eligible = chains.filter((candidate) => pillEligible(candidate, { sessionBranch: own, armedNumbers: [] }))
    expect(eligible).toEqual([])
  })
})
