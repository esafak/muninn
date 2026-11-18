import { describe, expect, test } from "bun:test"
import type { TieredRef } from "../extract"
import type { Chain, Entity, PullEntity, RepoRef, RunEntity } from "../model"
import {
  armedMergeEligible,
  commitDiscovery,
  createDiscoveryLedger,
  DISCOVERY_ABSENT_PRUNE_GENS,
  DISCOVERY_RETRY_MS,
  discoveryKey,
  excludeCoveredRefs,
  freshKeyFor,
  freshKeysFor,
  isOperationCurrent,
  isRefreshCurrent,
  ledgerKeyFor,
  partitionRefs,
  planDiscovery,
  releaseReservations,
  safetyRefs,
  shouldSettle,
  type DiscoveryEntry,
  type DiscoveryLedger,
  type FreshSafety,
} from "./hydration-policy"

const repo: RepoRef = { host: "github.com", owner: "acme", repo: "app" }
const otherRepo: RepoRef = { host: "github.com", owner: "other", repo: "lib" }

const ref = (over: Partial<TieredRef> = {}): TieredRef => ({
  number: 1,
  tier: "output",
  ...over,
})

const ledgerWith = (entries: [string, DiscoveryEntry][]): DiscoveryLedger => ({
  seen: new Map(entries.map(([key, entry]) => [key, entry])),
})

describe("discoveryKey / ledgerKeyFor", () => {
  test("keys are repo-scoped number identities", () => {
    expect(discoveryKey(repo, 53)).toBe("github.com/acme/app#53")
  })
  test("bare refs inherit the session repo", () => {
    expect(ledgerKeyFor(ref({ number: 7 }), repo)).toBe("github.com/acme/app#7")
  })
  test("explicit repos win over the session repo", () => {
    expect(ledgerKeyFor(ref({ number: 7, repo: otherRepo }), repo)).toBe("github.com/other/lib#7")
  })
  test("unresolvable refs stay undefined", () => {
    expect(ledgerKeyFor(ref({ number: 7 }), undefined)).toBeUndefined()
  })
})

describe("partitionRefs", () => {
  const armedRepos = new Set<string>()
  test("deliberate tiers are always live", () => {
    for (const tier of ["user", "command", "prose"] as const) {
      const { live, discovery } = partitionRefs([ref({ tier })], repo, armedRepos)
      expect(live).toHaveLength(1)
      expect(discovery).toHaveLength(0)
    }
  })
  test("plain output refs go to discovery", () => {
    const { live, discovery } = partitionRefs([ref()], repo, armedRepos)
    expect(live).toHaveLength(0)
    expect(discovery).toHaveLength(1)
  })
  test("armed-repo run refs stay live", () => {
    const repos = new Set(["github.com/acme/app"])
    const { live, discovery } = partitionRefs(
      [ref({ number: 11, kind: "run", repo }), ref({ number: 12, kind: "pr", repo })],
      repo,
      repos,
    )
    expect(live.map((r) => r.number)).toEqual([11])
    expect(discovery.map((r) => r.number)).toEqual([12])
  })
  test("unresolvable refs ride the live lane exactly as today", () => {
    const { live, discovery } = partitionRefs([ref({ number: 5 })], undefined, armedRepos)
    expect(live).toHaveLength(1)
    expect(discovery).toHaveLength(0)
  })
})

describe("excludeCoveredRefs", () => {
  const safetyPr = (number: number): TieredRef => ({ repo, number, kind: "pr", tier: "user" })
  test("same-kind transcript refs are covered", () => {
    const { kept, covered } = excludeCoveredRefs([ref({ number: 20, kind: "pr", repo })], [safetyPr(20)], repo)
    expect(kept).toHaveLength(0)
    expect(covered).toBe(1)
  })
  test("bare refs are subsumed by pr/issue safety refs", () => {
    const { kept } = excludeCoveredRefs([ref({ number: 21, repo })], [{ repo, number: 21, kind: "issue", tier: "user" }], repo)
    expect(kept).toHaveLength(0)
  })
  test("bare refs are NOT subsumed by run-only covers", () => {
    const { kept, covered } = excludeCoveredRefs([ref({ number: 22, repo })], [{ repo, number: 22, kind: "run", tier: "user" }], repo)
    expect(kept.map((r) => r.number)).toEqual([22])
    expect(covered).toBe(0)
  })
  test("kinded refs are never subsumed by a different kind", () => {
    // Deliberate `run 77` while armed PR #77 exists keeps its run payload.
    const { kept } = excludeCoveredRefs([ref({ number: 77, kind: "run", tier: "user", repo })], [safetyPr(77)], repo)
    expect(kept.map((r) => r.kind)).toEqual(["run"])
    const issue = excludeCoveredRefs([ref({ number: 78, kind: "issue", repo })], [safetyPr(78)], repo)
    expect(issue.kept).toHaveLength(1)
  })
  test("covered refs drop while unresolvable refs pass through", () => {
    const { kept, covered } = excludeCoveredRefs([ref({ number: 30, repo }), ref({ number: 31 })], [safetyPr(30)], undefined)
    // #30 resolves against its explicit repo and is subsumed; #31 has no repo
    // and no session repo, so coverage cannot apply and it rides along.
    expect(kept.map((r) => r.number)).toEqual([31])
    expect(covered).toBe(1)
  })
})

describe("planDiscovery", () => {
  test("new keys are admitted as the delta", () => {
    const ledger = createDiscoveryLedger()
    const plan = planDiscovery([ref({ number: 1 }), ref({ number: 2 })], repo, ledger, 1, 0, false)
    expect(plan.admit.map((r) => r.number)).toEqual([1, 2])
    expect(plan.deferred).toBe(0)
    expect(plan.invalid).toBe(0)
  })
  test("invalid numbers never admit", () => {
    const ledger = createDiscoveryLedger()
    const plan = planDiscovery([ref({ number: 0 }), ref({ number: -3 })], repo, ledger, 1, 0, false)
    expect(plan.admit).toHaveLength(0)
    expect(plan.invalid).toBe(2)
  })
  test("unchanged hydrated keys freeze on polls and admit on explicit refresh", () => {
    const key = discoveryKey(repo, 4)
    const ledger = ledgerWith([[key, { lastSeenGen: 1, hydratedAt: 100 }]])
    const frozen = planDiscovery([ref({ number: 4 })], repo, ledger, 2, 200, false)
    expect(frozen.admit).toHaveLength(0)
    expect(frozen.frozen).toBe(1)
    expect(frozen.awaitingRetry).toBe(0)
    const full = planDiscovery([ref({ number: 4 })], repo, ledger, 3, 300, true)
    expect(full.admit.map((r) => r.number)).toEqual([4])
  })
  test("unresolved keys back off, then retry when due", () => {
    const key = discoveryKey(repo, 5)
    const ledger = ledgerWith([[key, { lastSeenGen: 1, retryDueAt: 1000 }]])
    const waiting = planDiscovery([ref({ number: 5 })], repo, ledger, 2, 500, false)
    expect(waiting.admit).toHaveLength(0)
    expect(waiting.deferred).toBe(1)
    expect(waiting.awaitingRetry).toBe(1)
    const due = planDiscovery([ref({ number: 5 })], repo, ledger, 3, 1000, false)
    expect(due.admit.map((r) => r.number)).toEqual([5])
    expect(due.awaitingRetry).toBe(0)
  })
  test("reserved keys are skipped until their own completion releases them", () => {
    const ledger = createDiscoveryLedger()
    const first = planDiscovery([ref({ number: 6 })], repo, ledger, 1, 0, false)
    expect(first.admit).toHaveLength(1)
    const concurrent = planDiscovery([ref({ number: 6 })], repo, ledger, 2, 10, false)
    expect(concurrent.admit).toHaveLength(0)
    expect(concurrent.deferred).toBe(1)
    releaseReservations(ledger, 1)
    const after = planDiscovery([ref({ number: 6 })], repo, ledger, 3, 20, false)
    expect(after.admit.map((r) => r.number)).toEqual([6])
  })
  test("absent keys prune after the window and return as new", () => {
    const key = discoveryKey(repo, 7)
    const ledger = ledgerWith([[key, { lastSeenGen: 1, hydratedAt: 50 }]])
    const pruned = planDiscovery([], repo, ledger, 1 + DISCOVERY_ABSENT_PRUNE_GENS + 1, 0, false)
    expect(pruned.pruned).toBe(1)
    expect(ledger.seen.has(key)).toBe(false)
    const returned = planDiscovery([ref({ number: 7 })], repo, ledger, 10, 0, false)
    expect(returned.admit.map((r) => r.number)).toEqual([7])
  })
})

describe("commitDiscovery", () => {
  test("success clears backoff and stamps hydration", () => {
    const key = discoveryKey(repo, 8)
    const ledger = ledgerWith([[key, { lastSeenGen: 1, reservedOp: 1, retryDueAt: 500 }]])
    commitDiscovery(ledger, [ref({ number: 8 })], [], repo, 900)
    expect(ledger.seen.get(key)).toEqual({ lastSeenGen: 1, hydratedAt: 900 })
  })
  test("misses take the fixed retry", () => {
    const key = discoveryKey(repo, 9)
    const ledger = ledgerWith([[key, { lastSeenGen: 1, reservedOp: 1 }]])
    commitDiscovery(ledger, [ref({ number: 9 })], [{ number: 9, repo }], repo, 900)
    expect(ledger.seen.get(key)?.retryDueAt).toBe(900 + DISCOVERY_RETRY_MS)
    expect(ledger.seen.get(key)?.reservedOp).toBeUndefined()
  })
  test("only admitted keys are touched", () => {
    const key = discoveryKey(repo, 10)
    const ledger = ledgerWith([[key, { lastSeenGen: 1 }]])
    commitDiscovery(ledger, [], [{ number: 10, repo }], repo, 900)
    expect(ledger.seen.get(key)).toEqual({ lastSeenGen: 1 })
  })
})

describe("armedMergeEligible", () => {
  const key = freshKeyFor(repo, "pr", 53)
  const runKey = freshKeyFor(repo, "run", 18404)
  const fresh = (over: Partial<FreshSafety> = {}): FreshSafety => ({
    op: 7,
    sessionKey: "session\ndirectory",
    keys: new Set([key]),
    ...over,
  })
  test("allows fresh keys in the current operation and session", () => {
    expect(armedMergeEligible(fresh(), "session\ndirectory", 7, [key])).toBe(true)
  })
  test("requires every run dependency fresh too", () => {
    expect(armedMergeEligible(fresh(), "session\ndirectory", 7, [key, runKey])).toBe(false)
    expect(
      armedMergeEligible(fresh({ keys: new Set([key, runKey]) }), "session\ndirectory", 7, [key, runKey]),
    ).toBe(true)
  })
  test("a stale successful run does not authorize a fresh ready PR", () => {
    // PR rehydrated ready this generation; its current-head run failed to
    // hydrate (unresolved) so its key is absent: fail closed, no merge.
    const onlyPr = fresh({ keys: new Set([key]) })
    expect(armedMergeEligible(onlyPr, "session\ndirectory", 7, [key, runKey])).toBe(false)
  })
  test("fresh PR and run identities never cross-satisfy", () => {
    // Same number in the other kind's slot must not authorize.
    expect(armedMergeEligible(fresh({ keys: new Set([freshKeyFor(repo, "pr", 18404)]) }), "session\ndirectory", 7, [runKey])).toBe(false)
    expect(armedMergeEligible(fresh(), "session\ndirectory", 7, [freshKeyFor(repo, "run", 53)])).toBe(false)
  })
  test("blocks superseded operations", () => {
    expect(armedMergeEligible(fresh({ op: 6 }), "session\ndirectory", 7, [key])).toBe(false)
  })
  test("blocks session changes", () => {
    expect(armedMergeEligible(fresh(), "other\ndirectory", 7, [key])).toBe(false)
  })
  test("blocks omitted keys and missing evidence", () => {
    expect(armedMergeEligible(fresh(), "session\ndirectory", 7, [freshKeyFor(repo, "pr", 54)])).toBe(false)
    expect(armedMergeEligible(undefined, "session\ndirectory", 7, [key])).toBe(false)
    expect(armedMergeEligible(fresh(), "session\ndirectory", 7, [])).toBe(true)
  })
})

describe("planDiscovery budget", () => {
  const many = (count: number, start = 1): TieredRef[] =>
    Array.from({ length: count }, (_, i) => ref({ number: start + i, tier: "output", repo }));
  test("admits only up to budget and retains the rest pending", () => {
    const ledger = createDiscoveryLedger();
    const first = planDiscovery(many(70), repo, ledger, 1, 0, false, 64);
    expect(first.admit).toHaveLength(64);
    expect(first.deferred).toBe(6);
    expect(ledger.seen.size).toBe(70);
    // The deferred six are still pending: a new generation admits them.
    const second = planDiscovery(many(70), repo, ledger, 2, 10, false, 64);
    expect(second.admit.map((r) => r.number)).toEqual([65, 66, 67, 68, 69, 70]);
  });
  test("committed keys do not readmit on the next poll", () => {
    const ledger = createDiscoveryLedger();
    const admitted = planDiscovery([ref({ number: 1, repo })], repo, ledger, 1, 0, false, 64).admit;
    commitDiscovery(ledger, admitted, [], repo, 10);
    const next = planDiscovery([ref({ number: 1, repo })], repo, ledger, 2, 20, false, 64);
    expect(next.admit).toHaveLength(0);
    expect(next.frozen).toBe(1);
  });
});

describe("safetyRefs", () => {
  const pull = (over: Partial<PullEntity> = {}): PullEntity => ({
    kind: "pr",
    provider: "github",
    repo,
    number: 1,
    title: "t",
    state: "open",
    headBranch: "b",
    baseBranch: "main",
    closes: [],
    headSha: "sha",
    url: "https://github.com/acme/app/pull/1",
    updatedAt: 0,
    ...over,
  });
  const run = (over: Partial<RunEntity> = {}): RunEntity => ({
    kind: "run",
    provider: "github",
    repo,
    id: 101,
    name: "ci",
    headBranch: "b",
    headSha: "sha",
    status: "succeeded",
    checks: [],
    pullRequests: [],
    url: "https://github.com/acme/app/actions/runs/101",
    updatedAt: 0,
    ...over,
  });
  const chain = (over: Partial<Chain> = {}): Chain => ({
    key: "k",
    prs: [],
    issues: [],
    runs: [],
    updatedAt: 0,
    ...over,
  });
  test("synthesizes armed, recovery, creation, target, pinned, and eligible members", () => {
    const refs = safetyRefs({
      chains: [chain({ key: "pinned", prs: [pull({ number: 10 })] }), chain({ key: "eligible", prs: [pull({ number: 20 })], runs: [run({ id: 201 })] })],
      eligibleKeys: new Set(["eligible"]),
      pinnedKey: "pinned",
      armed: [{ repo, number: 30 }],
      recovery: [{ repo, number: 31 }],
      creation: [{ repo, number: 32, kind: "pr", tier: "command" }],
      target: { repo, number: 33 },
    });
    const keys = refs.map((r) => `${r.number}:${r.kind}`);
    for (const expected of ["30:pr", "31:pr", "32:pr", "33:pr", "10:pr", "20:pr", "201:run"]) expect(keys).toContain(expected);
  });
  test("adds current-head runs of armed PRs and dedupes repeats", () => {
    const refs = safetyRefs({
      chains: [chain({ key: "a", prs: [pull({ number: 40, headSha: "sha" })], runs: [run({ id: 202, headSha: "sha" }), run({ id: 203, headSha: "other" })] })],
      eligibleKeys: new Set<string>(),
      pinnedKey: undefined,
      armed: [
        { repo, number: 40 },
        { repo, number: 40 },
      ],
      recovery: [],
      creation: [],
      target: undefined,
    });
    const keys = refs.map((r) => `${r.number}:${r.kind}`);
    expect(keys).toContain("40:pr");
    expect(keys).toContain("202:run");
    expect(keys).not.toContain("203:run");
    expect(keys.filter((k) => k === "40:pr")).toHaveLength(1);
  });
});

describe("freshKeysFor", () => {
  test("collects PR and run keys, skips the rest", () => {
    const pr = { kind: "pr", repo, number: 5 } as PullEntity;
    const run = { kind: "run", repo, id: 606 } as RunEntity;
    const issue = { kind: "issue", repo, number: 7 } as Entity;
    expect([...freshKeysFor([pr, run, issue])].sort()).toEqual(["pr:github.com/acme/app#5", "run:github.com/acme/app#606"]);
  });
});

describe("shouldSettle", () => {
  test("the latest sent operation settles when current", () => {
    expect(shouldSettle(7, 7, true)).toBe(true);
  });
  test("A/B reverse completion: the late first operation does not settle", () => {
    // A sent first (op 6), B sent second (op 7) and completed. A's late
    // completion must release instead of committing or merging.
    expect(shouldSettle(7, 7, true)).toBe(true);
    expect(shouldSettle(6, 7, true)).toBe(false);
  });
  test("superseded and stale pipelines do not settle", () => {
    expect(shouldSettle(6, 7, true)).toBe(false);
    expect(shouldSettle(7, 7, false)).toBe(false);
    expect(shouldSettle(7, 9, true)).toBe(false);
  });
});

describe("isOperationCurrent", () => {
  test("accepts the latest sent operation with a live session and generation", () => {
    expect(isOperationCurrent(true, 7, 7, 12, 12)).toBe(true);
  });
  test("refresh-A/debounce-B reverse completion: A's older op does not proceed", () => {
    // A (op 11) sent first and is still awaiting branchRuns; B (op 12) fired,
    // sent, and completed. A's completion check fails on the op token even
    // though session and generation still match.
    expect(isOperationCurrent(true, 7, 7, 11, 12)).toBe(false);
    // B itself proceeds.
    expect(isOperationCurrent(true, 7, 7, 12, 12)).toBe(true);
  });
  test("rejects superseded generations, changed sessions, and newer in-flight ops", () => {
    expect(isOperationCurrent(true, 6, 7, 11, 11)).toBe(false);
    expect(isOperationCurrent(false, 7, 7, 11, 11)).toBe(false);
    expect(isOperationCurrent(true, 7, 7, 11, 12)).toBe(false);
  });
});

describe("isRefreshCurrent", () => {
  test("a newer hydrate op does not invalidate branch-run evidence", () => {
    // Regression: branch runs come from their own RPC, not from the hydrate
    // operation. The message debounce bumps lastSentOp ~600ms after every
    // hydrate, while branchRuns is still in flight. Gating setRuns on
    // isOperationCurrent(opId, lastSentOp) discarded every branch-run result.
    // Here op 11 is no longer the latest sent op (12), yet the branch-run
    // result stays valid for this session/generation.
    const sessionOk = true
    expect(isOperationCurrent(sessionOk, 7, 7, 11, 12)).toBe(false)
    expect(isRefreshCurrent(sessionOk, 7, 7)).toBe(true)
  });
  test("still rejects a stale generation or changed session", () => {
    expect(isRefreshCurrent(true, 6, 7)).toBe(false)
    expect(isRefreshCurrent(false, 7, 7)).toBe(false)
    expect(isRefreshCurrent(true, 7, 7)).toBe(true)
  });
});

describe("planDiscovery duplicate keys", () => {
  test("later transcript occurrence wins, matching the server collapse", () => {
    const ledger = createDiscoveryLedger();
    const plan = planDiscovery(
      [ref({ number: 55, kind: "run", repo }), ref({ number: 55, repo })],
      repo,
      ledger,
      1,
      0,
      false,
    );
    expect(plan.admit).toHaveLength(1);
    expect(plan.admit[0]?.kind).toBeUndefined();
    expect(plan.deferred).toBe(0);
    // Reverse order: the kinded payload wins instead.
    const ledger2 = createDiscoveryLedger();
    const plan2 = planDiscovery(
      [ref({ number: 55, repo }), ref({ number: 55, kind: "run", repo })],
      repo,
      ledger2,
      1,
      0,
      false,
    );
    expect(plan2.admit).toHaveLength(1);
    expect(plan2.admit[0]?.kind).toBe("run");
  });
  test("a duplicate reserved by another in-flight operation is left alone", () => {
    const ledger = createDiscoveryLedger();
    const first = planDiscovery([ref({ number: 55, kind: "run", repo })], repo, ledger, 1, 0, false);
    expect(first.admit[0]?.kind).toBe("run");
    // Same generation space, different operation: must not swap the other
    // operation's reservation, and must not admit a second payload.
    const concurrent = planDiscovery([ref({ number: 55, repo })], repo, ledger, 1, 10, false, Number.POSITIVE_INFINITY, 2);
    expect(concurrent.admit).toHaveLength(0);
    expect(concurrent.deferred).toBe(1);
    // After that operation releases, the bare ref admits as new information.
    releaseReservations(ledger, 1);
    const after = planDiscovery([ref({ number: 55, repo })], repo, ledger, 2, 20, false);
    expect(after.admit).toHaveLength(1);
    expect(after.admit[0]?.kind).toBeUndefined();
  });
});
