import { describe, expect, test } from "bun:test"
import type { Chain, IssueEntity, PullEntity, RunEntity } from "./model"
import { chainTone, mergeReady, mergeWhy, armedTargets, pillPick, type ArmedEntry } from "./model"

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

  test("red checks, closed and merged PRs are not ready", () => {
    expect(mergeReady(chain({ runs: [run("failed")] }))).toBe(false)
    expect(mergeReady(chain({ prs: [pull({ state: "merged" })] }))).toBe(false)
    expect(mergeReady(chain({ prs: [] }))).toBe(false)
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
})

describe("chainTone", () => {
  test("failures and conflicts are danger; change requests too", () => {
    expect(chainTone(chain({ runs: [run("failed")] }))).toBe("danger")
    expect(chainTone(chain({ prs: [pull({ mergeState: "conflict" })] }))).toBe("danger")
    expect(chainTone(chain({ prs: [pull({ reviewState: "changes_requested" })] }))).toBe("danger")
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

  test("issues alone carry no tone until open", () => {
    expect(chainTone(chain({ prs: [], issues: [issue("closed")], runs: [] }))).toBeUndefined()
    expect(chainTone(chain({ prs: [], issues: [issue("open")], runs: [] }))).toBeUndefined()
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

  test("run-only chains are the last resort", () => {
    const runOnly = chain({ key: "run", prs: [], runs: [run("succeeded")] })
    const picked = pillPick([runOnly])
    expect(picked?.reason).toBe("runs-only")
    expect(picked?.chain.key).toBe("run")
  })

  test("issue-only chains never win the pill (nothing to show)", () => {
    expect(pillPick([chain({ key: "issue", prs: [], runs: [], issues: [issue("open")] })])).toBeUndefined()
  })

  test("the runs-only fallback picks among run-bearing chains only, newest first", () => {
    // A merged PR chain filtered out as dead leaves an open issue chain and CI
    // runs: the pill must land on the runs, never on the run-less issue chain.
    const stale = chain({ key: "stale", prs: [], runs: [run("failed")], updatedAt: 100 })
    const issueOnly = chain({ key: "issue", prs: [], runs: [], issues: [issue("open")], updatedAt: 500 })
    const fresh = chain({ key: "fresh", prs: [], runs: [run("running")], updatedAt: 300 })
    const picked = pillPick([stale, issueOnly, fresh])
    expect(picked?.reason).toBe("runs-only")
    expect(picked?.chain.key).toBe("fresh")
    expect(picked?.considered).toBe(2)
  })

  test("no chains, no pill", () => {
    expect(pillPick([])).toBeUndefined()
  })
})
