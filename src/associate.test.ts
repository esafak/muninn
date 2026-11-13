import { describe, expect, test } from "bun:test"
import { associate } from "./associate"
import { chainTone, latestRun, latestRuns, pillEligible, pillPick, type IssueEntity, type PullEntity, type RunEntity } from "./model"

const repo = { host: "github.com", owner: "sst", repo: "opencode" } as const
const at = (ms: number) => ms

const issue: IssueEntity = { kind: "issue", provider: "github", repo, number: 1043, title: "Scroll jank", state: "open", url: "u", updatedAt: at(100) }
const pull: PullEntity = {
  kind: "pr",
  provider: "github",
  repo,
  number: 4821,
  title: "Fix scroll",
  state: "open",
  headBranch: "fix-scroll-state",
  baseBranch: "dev",
  closes: [1043],
  headSha: "abc123",
  url: "u",
  updatedAt: at(200),
}
const run = (id: number, sha: string, updatedAt: number): RunEntity => ({
  kind: "run",
  provider: "github",
  repo,
  id,
  name: "ci",
  headBranch: "fix-scroll-state",
  headSha: sha,
  status: "succeeded",
  checks: [],
  pullRequests: [],
  url: "u",
  updatedAt,
})

describe("associate", () => {
  test("a pull request claims its runs and its issue", () => {
    const chains = associate([issue, pull, run(18402, "abc123", 150), run(18404, "abc123", 300)])
    expect(chains).toHaveLength(1)
    expect(chains[0]?.prs[0]?.number).toBe(4821)
    expect(chains[0]?.issues[0]?.number).toBe(1043)
    expect(chains[0]?.runs.map((r) => r.id)).toEqual([18404, 18402])
    expect(chains[0]?.updatedAt).toBe(300)
  })

  test("runs from other repositories do not join", () => {
    const other: RunEntity = { ...run(9, "abc123", 50), repo: { host: "github.com", owner: "acme", repo: "api" } }
    const chains = associate([pull], [other])
    expect(chains[0]?.runs).toEqual([])
    expect(chains).toHaveLength(2)
  })

  test("review-comment runs with empty PR metadata attach by branch when their SHA differs", () => {
    const reviewerRun: RunEntity = {
      ...run(18420, "merge-commit-sha", 250),
      headBranch: pull.headBranch,
      pullRequests: [],
      name: "Pi Reviewer",
    }
    const chains = associate([pull], [reviewerRun])

    expect(chains).toHaveLength(1)
    expect(chains[0]?.runs.map((candidate) => candidate.id)).toEqual([18420])
  })

  test("branch-only reviewer runs stay unattached when multiple PRs share the branch", () => {
    const sameBranchPull: PullEntity = { ...pull, number: 4822, headSha: "different-head" }
    const reviewerRun: RunEntity = {
      ...run(18421, "merge-commit-sha", 250),
      pullRequests: [],
      name: "Pi Reviewer",
    }
    const chains = associate([pull, sameBranchPull], [reviewerRun])

    expect(chains).toHaveLength(2)
    expect(chains.find((chain) => chain.prs.length === 0)?.runs.map((candidate) => candidate.id)).toEqual([18421])
  })

  test("unclaimed branch runs stand alone", () => {
    const chains = associate([pull], [{ ...run(18410, "def456", 400), headBranch: "unrelated-branch" }])
    const standalone = chains.find((chain) => chain.prs.length === 0)
    expect(standalone?.runs[0]?.id).toBe(18410)
  })

  test("unclaimed runs in one workflow series group stably and use sequence over completion time", () => {
    const oldFailure = { ...run(18430, "standalone-head", 500), status: "failed" as const, series: { key: "workflow-1", sequence: 10 } }
    const newSuccess = { ...run(18431, "standalone-head", 400), status: "succeeded" as const, series: { key: "workflow-1", sequence: 11 } }
    const grouped = associate([], [oldFailure, newSuccess])
    const permuted = associate([], [newSuccess, oldFailure])
    expect(grouped).toHaveLength(1)
    expect(grouped[0]?.runs.map((candidate) => candidate.id)).toEqual([18430, 18431])
    expect(permuted[0]?.key).toBe(grouped[0]?.key)
    expect(pillEligible(grouped[0]!)).toBe(false)
    expect(chainTone(grouped[0]!)).toBe("success")
    expect(latestRuns(grouped[0]!.runs).map((candidate) => candidate.id)).toEqual([18431])
    expect(latestRun(grouped[0]!.runs)?.id).toBe(18431)
    const eligible = grouped.filter((chain) => pillEligible(chain))
    expect(eligible).toEqual([])
    expect(pillPick(eligible)).toBeUndefined()
  })

  test("distinct workflows remain separate; standalone failures stay in the sidebar", () => {
    const passed = { ...run(18440, "same-head", 100), series: { key: "workflow-1", sequence: 1 } }
    const failed = { ...run(18441, "same-head", 110), status: "failed" as const, series: { key: "workflow-2", sequence: 2 } }
    const chains = associate([], [passed, failed])
    expect(chains).toHaveLength(2)
    const failedChain = chains.find((chain) => chain.runs[0]?.status === "failed")!
    // Session-created-only pills: run-only chains never pill on their own.
    expect(pillEligible(failedChain)).toBe(false)
    expect(chainTone(failedChain)).toBe("danger")
    expect(chains.filter((chain) => pillEligible(chain))).toEqual([])
  })

  test("different repo/head and missing series metadata do not group", () => {
    const series = { key: "workflow-1", sequence: 1 }
    const runs = [
      { ...run(18450, "head-a", 1), series },
      { ...run(18451, "head-b", 2), series },
      { ...run(18452, "head-a", 3), repo: { host: "github.com", owner: "acme", repo: "api" }, series },
      run(18453, "head-a", 4),
      run(18454, "head-a", 5),
    ]
    expect(associate([], runs)).toHaveLength(5)
  })

  test("issues with no closing PR stand alone", () => {
    const chains = associate([issue])
    expect(chains).toHaveLength(1)
    expect(chains[0]?.issues[0]?.number).toBe(1043)
  })

  test("chains order by last activity", () => {
    const olderPull: PullEntity = { ...pull, number: 4790, closes: [], headSha: "old", updatedAt: at(90) }
    const chains = associate([olderPull, pull])
    expect(chains[0]?.prs[0]?.number).toBe(4821)
  })

  test("duplicate references do not duplicate a PR and shared issue numbers stay repository-scoped", () => {
    const otherRepo = { ...repo, owner: "acme", repo: "api" }
    const otherPull: PullEntity = { ...pull, repo: otherRepo, number: 1, title: "Other repo PR", updatedAt: 300 }
    const chains = associate([pull, pull, otherPull])

    expect(chains).toHaveLength(2)
    expect(chains.find((chain) => chain.prs[0]?.repo.owner === repo.owner)?.prs.map((pr) => pr.number)).toEqual([4821])
    expect(chains.find((chain) => chain.prs[0]?.repo.owner === "acme")?.prs.map((pr) => pr.number)).toEqual([1])
  })

  test("run duplicates keep the fresher snapshot, whichever input carries it", () => {
    // Branch runs are listed later, but a cached entity can be newer (message
    // hydration refreshes it without re-listing the branch): freshness wins,
    // never input position — a stale green branch run must not mask a red one,
    // and a fresh green listing must still recover a stale red cache.
    const cachedFailure = associate([{ ...run(1, "abc123", 300), status: "failed" }], [run(1, "abc123", 100)])
    expect(cachedFailure[0]!.runs.map((run) => run.status)).toEqual(["failed"])

    const branchRecovery = associate([{ ...run(1, "abc123", 100), status: "failed" }], [run(1, "abc123", 300)])
    expect(branchRecovery[0]!.runs.map((run) => run.status)).toEqual(["succeeded"])
  })

  test("equal-timestamp duplicates keep the branch-run listing", () => {
    // The tie rule pins `<=` in the dedupe comparison: the later listing wins.
    const ties = associate([{ ...run(1, "abc123", 200), status: "failed" }], [run(1, "abc123", 200)])
    expect(ties[0]!.runs.map((run) => run.status)).toEqual(["succeeded"])
  })
})
