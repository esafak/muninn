import { describe, expect, test } from "bun:test"
import type { Chain, IssueEntity, PullEntity, RunEntity } from "../model"
import { pillDisplay } from "../model"
import { applyDismissal, overflowCount, pickableChains, pillViewForPick } from "./pill-view"

const repo = { host: "github.com", owner: "acme", repo: "app" }
const t = (key: string): string => key

const pull = (over: Partial<PullEntity> = {}): PullEntity => ({
  kind: "pr",
  provider: "github",
  repo,
  number: 2787,
  title: "fix(k8s): pin drifting images",
  state: "open",
  headBranch: "renovate/reconfigure",
  baseBranch: "main",
  closes: [],
  headSha: "abc123",
  url: "https://github.com/acme/app/pull/2787",
  updatedAt: 0,
  statusChecks: { headSha: "abc123", state: "available", contexts: [] },
  ...over,
})

const issue = (over: Partial<IssueEntity> = {}): IssueEntity => ({
  kind: "issue",
  provider: "github",
  repo,
  number: 1043,
  title: "bug: thing",
  state: "open",
  url: "https://github.com/acme/app/issues/1043",
  updatedAt: 0,
  ...over,
})

const run = (over: Partial<RunEntity> = {}): RunEntity => ({
  kind: "run",
  provider: "github",
  repo,
  id: 906,
  name: "ci",
  headBranch: "feat/thing",
  headSha: "abc123",
  status: "succeeded",
  checks: [],
  pullRequests: [],
  url: "https://github.com/acme/app/actions/runs/906",
  updatedAt: 0,
  ...over,
})

const chain = (over: Partial<Chain> = {}): Chain => ({
  key: "k",
  prs: [],
  issues: [],
  runs: [],
  updatedAt: 0,
  ...over,
})

const opts = (over: Partial<Parameters<typeof pillViewForPick>[1]> = {}) => ({
  waitForAllStatusChecks: true,
  armed: false,
  spinFrame: "⠋",
  t,
  ...over,
})

describe("pillViewForPick", () => {
  test("open PR shows number, tone, merge detail in title", () => {
    const view = pillViewForPick(
      { chain: chain({ prs: [pull({ mergeState: "pending", reviewState: "pending" })] }), reason: "newest" },
      opts(),
    )
    expect(view?.label).toBe("#2787 fix(k8s): pin drifting i… ▾")
    expect(view?.title).toBe("#2787 fix(k8s): pin drifting images · merge pending · reviews pending")
    expect(view?.tone).toBe("warning")
    expect(view?.icon).toBe("circle-exclamation")
    expect(view?.title === view?.label).toBe(false)
  })

  test("draft PR keeps draft heading", () => {
    const view = pillViewForPick(
      { chain: chain({ prs: [pull({ state: "draft" })] }), reason: "newest" },
      opts(),
    )
    expect(view?.label).toBe("#2787 fix(k8s): pin drifting i… ▾")
    expect(view?.title).toBe("#2787 fix(k8s): pin drifting images · merge unknown")
    expect(view?.tone).toBe("warning")
    expect(view?.icon).toBe("circle-exclamation")
  })

  test("merged PR keeps the merged tag but drops the title", () => {
    const view = pillViewForPick(
      { chain: chain({ prs: [pull({ state: "merged" })] }), reason: "merged" },
      opts(),
    )
    expect(view?.label).toBe("#2787 · state.merged ▾")
    expect(view?.title).toBe("#2787 fix(k8s): pin drifting images · merged")
    expect(view?.tone).toBe("success")
    expect(view?.icon).toBe("branch")
  })

  test("closed pinned PR stays visible with danger tone", () => {
    const view = pillViewForPick(
      { chain: chain({ prs: [pull({ state: "closed" })] }), reason: "pinned" },
      opts(),
    )
    expect(view?.label).toBe("#2787 fix(k8s): pin drifting i… ▾")
    expect(view?.title).toBe("#2787 fix(k8s): pin drifting images · closed · pill.pinned")
    expect(view?.tone).toBe("danger")
    expect(view?.icon).toBe("circle-xmark")
  })

  test("armed open PR prefixes the spinner frame", () => {
    const view = pillViewForPick(
      { chain: chain({ prs: [pull()] }), reason: "newest" },
      opts({ armed: true, spinFrame: "⠙" }),
    )
    expect(view?.label).toBe("⠙ #2787 fix(k8s): pin drifting i… ▾")
    expect(view?.title).toBe("#2787 fix(k8s): pin drifting images · merge unknown")
    expect(view?.tone).toBe("warning")
    expect(view?.icon).toBe("circle-exclamation")
  })

  test("pinned suffix appears in title", () => {
    const view = pillViewForPick({ chain: chain({ prs: [pull()] }), reason: "pinned" }, opts())
    expect(view?.label).toBe("#2787 fix(k8s): pin drifting i… ▾")
    expect(view?.title).toBe("#2787 fix(k8s): pin drifting images · merge unknown · pill.pinned")
    expect(view?.tone).toBe("warning")
    expect(view?.icon).toBe("circle-exclamation")
  })

  test("issue-only pinned chain renders issue identity", () => {
    const view = pillViewForPick({ chain: chain({ issues: [issue()] }), reason: "pinned" }, opts())
    expect(view?.label).toBe("#1043 bug: thing ▾")
    expect(view?.tone).toBe("warning")
    expect(view?.icon).toBe("circle-exclamation")
    expect(view?.title).toBe("#1043 bug: thing · issue open · pill.pinned")
  })

  test("run-only failure names run id and status", () => {
    const view = pillViewForPick(
      { chain: chain({ runs: [run({ status: "failed", id: 18404 })] }), reason: "runs-only" },
      opts(),
    )
    expect(view?.label).toBe("run #18404 · state.failed ▾")
    expect(view?.title).toBe("run #18404 · failed")
    expect(view?.tone).toBe("danger")
    expect(view?.icon).toBe("circle-xmark")
  })

  test("run-only success omits the status suffix in the label", () => {
    const view = pillViewForPick({ chain: chain({ runs: [run()] }), reason: "runs-only" }, opts())
    expect(view?.label).toBe("run #906 ▾")
    expect(view?.title).toBe("run #906 · succeeded")
    expect(view?.tone).toBe("success")
    expect(view?.icon).toBe("circle-check")
  })

  test("empty chain withdraws", () => {
    expect(pillViewForPick({ chain: chain(), reason: "runs-only" }, opts())).toBeUndefined()
  })
})

describe("pickableChains / overflowCount", () => {
  const eligible = [chain({ key: "a" }), chain({ key: "b" }), chain({ key: "c" })]
  test("empty dismissal keeps the pool", () => {
    expect(pickableChains(eligible, new Set()).map((c) => c.key)).toEqual(["a", "b", "c"])
  })
  test("dismissed chains leave the pool before capping (slot backfill)", () => {
    expect(pickableChains(eligible, new Set(["a"])).map((c) => c.key)).toEqual(["b", "c"])
  })
  test("overflow excludes dismissed chains", () => {
    const picks = [{ chain: chain({ key: "a" }), reason: "newest" as const }]
    // "b" dismissed: not displayed, not advertised — only "c" overflows.
    expect(overflowCount(pickableChains(eligible, new Set(["b"])), picks)).toBe(1)
    expect(overflowCount(pickableChains(eligible, new Set()), picks)).toBe(2)
  })
  test("ineligible pin consuming a slot shrinks displayed-eligible count", () => {
    const picks = [
      { chain: chain({ key: "foreign" }), reason: "pinned" as const },
      { chain: chain({ key: "a" }), reason: "newest" as const },
    ]
    expect(overflowCount(pickableChains(eligible, new Set()), picks)).toBe(2)
  })
  test("pillDisplay backfills a dismissed slot from the filtered pool", () => {
    const openChain = (key: string, n: number): Chain =>
      chain({ key, prs: [pull({ number: n, title: `feat ${key}` })] })
    const eligible = ["a", "b", "c", "d", "e", "f"].map((k, i) => openChain(k, 1000 + i))
    const picks = pillDisplay(pickableChains(eligible, new Set(["b"])), undefined, true, 5)
    expect(picks.map((p) => p.chain.key)).toEqual(["a", "c", "d", "e", "f"])
  })
  test("pillDisplay reinserts a dismissed pin at the lead", () => {
    const openChain = (key: string, n: number): Chain =>
      chain({ key, prs: [pull({ number: n, title: `feat ${key}` })] })
    const eligible = [openChain("a", 1), openChain("b", 2)]
    const pinned = openChain("b", 2)
    const picks = pillDisplay(pickableChains(eligible, new Set(["b"])), pinned, true, 5)
    expect(picks[0]?.chain.key).toBe("b")
    expect(picks[0]?.reason).toBe("pinned")
  })
  test("dismissed pin survives in picks via the pin override", () => {
    const picks = [{ chain: chain({ key: "a" }), reason: "pinned" as const }]
    expect(applyDismissal(picks, new Set(["a"])).map((p) => p.chain.key)).toEqual(["a"])
    expect(overflowCount(pickableChains(eligible, new Set(["a"])), picks)).toBe(2)
  })
})

describe("applyDismissal", () => {
  const picks = [
    { chain: chain({ key: "a" }), reason: "newest" as const },
    { chain: chain({ key: "b" }), reason: "newest" as const },
    { chain: chain({ key: "c" }), reason: "pinned" as const },
  ]
  test("empty dismissal shows everything", () => {
    expect(applyDismissal(picks, new Set()).map((p) => p.chain.key)).toEqual(["a", "b", "c"])
  })
  test("dismissed chains drop out", () => {
    expect(applyDismissal(picks, new Set(["a"])).map((p) => p.chain.key)).toEqual(["b", "c"])
  })
  test("pinned entries survive dismissal (pin re-adds)", () => {
    expect(applyDismissal(picks, new Set(["c"])).map((p) => p.chain.key)).toEqual(["a", "b", "c"])
  })
  test("unknown keys are ignored", () => {
    expect(applyDismissal(picks, new Set(["zzz"])).map((p) => p.chain.key)).toEqual(["a", "b", "c"])
  })
})
