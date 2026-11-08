import { describe, expect, test } from "bun:test"
import type { Chain, IssueEntity, PullEntity, RunEntity } from "./model"
import { chainTone, mergeReady, mergeWhy } from "./model"

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
