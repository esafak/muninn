import { describe, expect, test } from "bun:test"
import type { Chain, IssueEntity, PullEntity, RunEntity } from "../model"
import { applyDismissal, marquee, marqueeFingerprint, marqueeTotal, overflowCount, pillViewForPick, slotEntry } from "./pill-view"

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

  test("merged PR names merged state", () => {
    const view = pillViewForPick(
      { chain: chain({ prs: [pull({ state: "merged" })] }), reason: "merged" },
      opts(),
    )
    expect(view?.label).toBe("#2787 fix(k8s): pin drifting i… · state.merged ▾")
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

describe("slotEntry / overflowCount", () => {
  const key = (n: string): Chain => chain({ key: n })
  test("empty slot withdraws", () => {
    expect(slotEntry([], 0)).toBeUndefined()
  })
  test("zero picks, zero overflow", () => {
    expect(overflowCount([], [])).toBe(0)
  })
  test("one pick, no overflow", () => {
    const picks = [{ chain: key("a"), reason: "newest" } as const]
    expect(slotEntry(picks, 0)?.chain.key).toBe("a")
    expect(slotEntry(picks, 1)).toBeUndefined()
    expect(overflowCount([key("a")], picks)).toBe(0)
  })
  test("five picks cap leaves the sixth as overflow", () => {
    const eligible = [key("a"), key("b"), key("c"), key("d"), key("e"), key("f")]
    const picks = eligible.slice(0, 5).map((c) => ({ chain: c, reason: "newest" as const }))
    expect(overflowCount(eligible, picks)).toBe(1)
  })
  test("ineligible pin consuming a slot shrinks displayed-eligible count", () => {
    const eligible = [key("a"), key("b")]
    const pin = { chain: key("foreign"), reason: "pinned" as const }
    const picks = [pin, { chain: key("a"), reason: "newest" as const }]
    expect(overflowCount(eligible, picks)).toBe(1)
  })
  test("refresh keeps the slot, reorder and disappearance change it", () => {
    const picks = [
      { chain: key("a"), reason: "newest" as const },
      { chain: key("b"), reason: "newest" as const },
    ]
    expect(slotEntry(picks, 0)?.chain.key).toBe("a")
    const refreshed = [
      { chain: key("a"), reason: "newest" as const },
      { chain: key("b"), reason: "newest" as const },
    ]
    expect(slotEntry(refreshed, 0)?.chain.key).toBe(slotEntry(picks, 0)?.chain.key)
    const reordered = [picks[1]!, picks[0]!]
    expect(slotEntry(reordered, 0)?.chain.key).toBe("b")
    const disappeared = [picks[0]!]
    expect(slotEntry(disappeared, 1)).toBeUndefined()
  })
})

describe("marquee", () => {
  const title = "fix(k8s): pin drifting images"
  test("short names stay static at any offset", () => {
    expect(marquee("bug: thing", 7)).toBe("bug: thing")
  })
  test("offset 0 matches the static truncated form", () => {
    expect(marquee(title, 0)).toBe("fix(k8s): pin drifting i…")
    expect(marquee(title)).toBe("fix(k8s): pin drifting i…")
  })
  test("later offsets scroll a 24-char window", () => {
    const scrolled = marquee(title, 5)
    expect(scrolled.length).toBe(24)
    expect(scrolled).not.toBe("fix(k8s): pin drifting i…")
    expect(title.replace(/\s+/g, " ")).toContain(scrolled.replace(/\s+$/, ""))
  })
  test("offset wraps around the loop", () => {
    const loop = `${title}   `
    expect(marquee(title, loop.length)).toBe(marquee(title, 0).slice(0, 24))
    expect(marquee(title, loop.length + 5)).toBe(marquee(title, 5))
  })
  test("builder threads the offset into the label", () => {
    const view = pillViewForPick(
      { chain: chain({ prs: [pull()] }), reason: "newest" },
      opts({ marqueeOffset: 5 }),
    )
    expect(view?.label).toContain(marquee(pull().title, 5))
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

describe("marqueeFingerprint / marqueeTotal", () => {
  const picks = () => [
    { chain: chain({ key: "a", updatedAt: 1 }), reason: "newest" as const },
    { chain: chain({ key: "b", updatedAt: 2 }), reason: "newest" as const },
  ]
  test("unchanged refresh keeps the signature", () => {
    expect(marqueeFingerprint(picks())).toBe(marqueeFingerprint(picks()))
  })
  test("key, freshness, reason, and order changes all differ", () => {
    const base = marqueeFingerprint(picks())
    const [first, second] = picks()
    expect(marqueeFingerprint([second!, first!])).not.toBe(base)
    expect(marqueeFingerprint([{ ...first!, chain: chain({ key: "a", updatedAt: 9 }) }])).not.toBe(base)
    expect(marqueeFingerprint([{ ...first!, reason: "pinned" as const }])).not.toBe(base)
  })
  test("total is undefined when nothing scrolls", () => {
    expect(marqueeTotal(24)).toBeUndefined()
    expect(marqueeTotal(10)).toBeUndefined()
  })
  test("total covers one full pass, terminal step is the static form", () => {
    expect(marqueeTotal(29)).toBe(8)
    const title = "fix(k8s): pin drifting images"
    // Completion parks at step 0: identical to the static truncated label.
    expect(marquee(title, 0)).toBe("fix(k8s): pin drifting i…")
  })
})
