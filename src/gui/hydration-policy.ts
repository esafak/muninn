/**
 * Tier-aware hydration policy: which transcript refs a refresh may send to the
 * forge, and when output-tier discovery refs are due again. Pure (no Solid, no
 * ctx), so tests cover every rule; the GUI threads the ledger through refresh
 * and the message debounce, which share one policy but never share ledgers
 * across sessions or directories.
 *
 * Cost model: every admitted ref costs roughly one provider call per refresh.
 * Deliberate refs (user/command/prose) and operational refs (armed PRs,
 * recovery targets, creation links, pinned and pill-eligible chain members,
 * same-repo/current-head runs of armed PRs) hydrate every refresh — pills and
 * merge-when-ready must decide on fresh evidence. Output-tier discovery refs
 * hydrate on first sight and on explicit refreshes, then freeze: they can
 * never recruit a pill via mention, so steady-state polls must not resend
 * them. Unresolved discovery refs retry on a fixed backoff, not every poll.
 */

import type { TieredRef } from "../extract"
import { repoKey, type Chain, type Entity, type RepoRef } from "../model"

/** Ledger identity for one hydratable reference: repo-scoped `owner/repo#number`.
 * Kind-agnostic on purpose: hydrate fans bare refs out by payload, and a PR
 * number that later resolves as an issue (or vice versa) must not double-book. */
export const discoveryKey = (repo: RepoRef, number: number): string => `${repoKey(repo)}#${number}`

/** Resolve a transcript ref to its ledger identity against the session repo
 * (bare refs inherit it). Returns undefined when unresolvable — those refs
 * never hydrate server-side either, so they ride the live lane unchanged. */
export const ledgerKeyFor = (ref: TieredRef, sessionRepo: RepoRef | undefined): string | undefined => {
  const repo = ref.repo ?? sessionRepo
  if (!repo) return undefined
  return discoveryKey(repo, ref.number)
}

/** How long an unresolved discovery ref waits before its next attempt. Fixed
 * and conservative: without failure classification (the RPC reports every
 * miss the same way) there is no honest 404/transient split, so one schedule
 * covers both. Permanent garbage then costs ~12 attempts/hour/ref instead of
 * ~120 — a reduction, not a quota fix; unauthenticated quota still needs a
 * connected forge token. */
export const DISCOVERY_RETRY_MS = 5 * 60_000

/** Transcript generations a ledger key may go unseen before it is pruned. */
export const DISCOVERY_ABSENT_PRUNE_GENS = 3

export interface DiscoveryEntry {
  lastSeenGen: number
  hydratedAt?: number
  retryDueAt?: number
  reservedOp?: number
}

export interface DiscoveryLedger {
  seen: Map<string, DiscoveryEntry>
}

export const createDiscoveryLedger = (): DiscoveryLedger => ({ seen: new Map() })

export interface DiscoveryPlan {
  /** Discovery refs to hydrate now (new deltas plus due retries). */
  admit: TieredRef[]
  /** Discovery refs held back (backing off). Stay pending. */
  deferred: number
  /** Previously hydrated discovery refs intentionally frozen this generation. */
  frozen: number
  /** Known-unresolved discovery refs still waiting out their backoff. */
  awaitingRetry: number
  /** Ledger keys pruned after going unseen past the prune window. */
  pruned: number
  /** Refs that fail number validation (mirror of wireRefs' dropped count). */
  invalid: number
}

const validNumber = (number: number): boolean => Number.isSafeInteger(number) && number > 0

/**
 * Admit this generation's discovery refs. New keys always hydrate (delta);
 * previously seen keys hydrate only on explicit refresh or when their retry
 * is due. Cap-deferred keys stay pending — they are never dropped by
 * advancement of the fingerprint. Reserved keys (admitted by a still-possible
 * in-flight call) are skipped; reservations are released by that call's own
 * completion path, fresh or stale, so nothing strands.
 */
export const planDiscovery = (
  refs: readonly TieredRef[],
  sessionRepo: RepoRef | undefined,
  ledger: DiscoveryLedger,
  /** Transcript sighting marker for prune accounting; reservation ownership uses opId. */
  gen: number,
  nowMs: number,
  full: boolean,
  budget: number = Number.POSITIVE_INFINITY,
  /** Distinct hydrate-operation token: concurrent refresh/debounce executions must not share reservations. */
  opId: number = gen,
): DiscoveryPlan => {
  let invalid = 0
  let deferred = 0
  let frozen = 0
  let awaitingRetry = 0
  let pruned = 0
  const admit: TieredRef[] = []
  const present = new Set<string>()
  const candidates: { ref: TieredRef; key: string }[] = []
  for (const ref of refs) {
    if (!validNumber(ref.number)) {
      invalid++
      continue
    }
    const key = ledgerKeyFor(ref, sessionRepo)
    // Unresolvable refs ride along exactly as today (the server skips them).
    if (key === undefined) {
      admit.push(ref)
      continue
    }
    present.add(key)
    const known = ledger.seen.get(key)
    if (!known) {
      // Brand-new keys always hydrate — unless the budget is spent, in which
      // case they wait as pending (recorded, never dropped).
      if (candidates.length >= budget) {
        ledger.seen.set(key, { lastSeenGen: gen })
        deferred++
        continue
      }
      ledger.seen.set(key, { lastSeenGen: gen, reservedOp: opId })
      candidates.push({ ref, key })
      continue
    }
    known.lastSeenGen = gen
    if (known.reservedOp !== undefined) {
      const candidate = known.reservedOp === opId ? candidates.find((entry) => entry.key === key) : undefined
      if (candidate) {
        // Same-operation duplicate: replace the admitted payload (last
        // transcript occurrence wins). Still admitted this round — not
        // deferred work, so the census stays honest.
        candidate.ref = ref
        continue
      }
      deferred++
      if (known.retryDueAt !== undefined && known.retryDueAt > nowMs) awaitingRetry++
      continue
    }
    if (full || known.retryDueAt === undefined || known.retryDueAt <= nowMs) {
      // Successful keys have no retryDueAt: they rehydrate only on explicit
      // refresh (frozen otherwise), which is exactly the `full` branch.
      if (!full && known.hydratedAt !== undefined && known.retryDueAt === undefined) {
        frozen++
        continue
      }
      // Budget-bounded: excess stays pending (retained, never dropped).
      if (candidates.length >= budget) {
        deferred++
        continue
      }
      known.reservedOp = opId
      candidates.push({ ref, key })
    } else {
      // Backing off: still known-unresolved, just not attempted this round.
      deferred++
      awaitingRetry++
    }
  }
  for (const candidate of candidates) admit.push(candidate.ref)
  for (const [key, entry] of ledger.seen)
    if (!present.has(key) && gen - entry.lastSeenGen > DISCOVERY_ABSENT_PRUNE_GENS) {
      ledger.seen.delete(key)
      pruned++
    }
  return { admit, deferred, frozen, awaitingRetry, pruned, invalid }
}

/** Release one operation's reservations (fresh completions commit first via
 * commitDiscovery; stale completions must still release, or stranded keys
 * would never be admitted again). Touches reservations only. */
export const releaseReservations = (ledger: DiscoveryLedger, opId: number): void => {
  for (const entry of ledger.seen.values()) if (entry.reservedOp === opId) delete entry.reservedOp
}

const unresolvedKey = (ref: { number: number; repo?: RepoRef }, sessionRepo: RepoRef | undefined): string | undefined => {
  const repo = ref.repo ?? sessionRepo
  if (!repo) return undefined
  return discoveryKey(repo, ref.number)
}

/**
 * Commit a completed generation: admitted refs absent from the unresolved set
 * count as hydrated (clearing backoff); the rest take the fixed retry.
 * Callers apply this only when the completion is still current — superseded
 * refreshes release instead (see releaseReservations), so stale evidence can
 * never mark keys fresh.
 */
export const commitDiscovery = (
  ledger: DiscoveryLedger,
  admitted: readonly TieredRef[],
  unresolved: readonly { number: number; repo?: RepoRef }[],
  sessionRepo: RepoRef | undefined,
  nowMs: number,
): void => {
  const missed = new Set<string>()
  for (const ref of unresolved) {
    const key = unresolvedKey(ref, sessionRepo)
    if (key !== undefined) missed.add(key)
  }
  for (const ref of admitted) {
    const key = ledgerKeyFor(ref, sessionRepo)
    if (key === undefined) continue
    const entry = ledger.seen.get(key)
    if (!entry) continue
    delete entry.reservedOp
    if (missed.has(key)) entry.retryDueAt = nowMs + DISCOVERY_RETRY_MS
    else {
      entry.hydratedAt = nowMs
      delete entry.retryDueAt
    }
  }
}

/**
 * Drop transcript refs whose payload a safety ref already covers. Coverage is
 * kind-aware: a transcript ref is dropped only when a safety ref carries the
 * same kind, or when the transcript ref is bare and a safety ref carries kind
 * pr or issue (the issues endpoint serves both, so the bare fan-out adds
 * nothing). A bare ref is NOT subsumed by a run-only cover, and a kinded ref
 * never is by a different kind — those keep their own payload, matching the
 * pre-diff behavior where every distinct requested ref was sent.
 */
export const excludeCoveredRefs = (
  requested: readonly TieredRef[],
  safety: readonly TieredRef[],
  sessionRepo: RepoRef | undefined,
): { kept: TieredRef[]; covered: number } => {
  const covered = new Map<string, Set<TieredRef["kind"]>>()
  for (const ref of safety) {
    const key = ledgerKeyFor(ref, sessionRepo)
    if (key === undefined) continue
    let kinds = covered.get(key)
    if (!kinds) {
      kinds = new Set()
      covered.set(key, kinds)
    }
    kinds.add(ref.kind)
  }
  const kept: TieredRef[] = []
  let coveredCount = 0
  for (const ref of requested) {
    const key = ledgerKeyFor(ref, sessionRepo)
    const kinds = key === undefined ? undefined : covered.get(key)
    if (kinds === undefined) {
      kept.push(ref)
      continue
    }
    if (kinds.has(ref.kind) || (ref.kind === undefined && (kinds.has("pr") || kinds.has("issue")))) {
      coveredCount++
      continue
    }
    kept.push(ref)
  }
  return { kept, covered: coveredCount }
}

/**
 * Split transcript refs into the always-hydrate live lane and the discovery
 * lane. Live = deliberate tiers (user/command/prose) plus output-tier run
 * refs (bare included) in armed repos. Coverage dedup lives in
 * excludeCoveredRefs — this function never sees covered refs. Stable order
 * preserved within each lane.
 */
export const partitionRefs = (
  refs: readonly TieredRef[],
  sessionRepo: RepoRef | undefined,
  armedRepos: ReadonlySet<string>,
): { live: TieredRef[]; discovery: TieredRef[] } => {
  const live: TieredRef[] = []
  const discovery: TieredRef[] = []
  for (const ref of refs) {
    if (ref.tier !== "output") {
      live.push(ref)
      continue
    }
    const key = ledgerKeyFor(ref, sessionRepo)
    if (key === undefined) {
      live.push(ref)
      continue
    }
    if ((ref.kind === "run" || ref.kind === undefined) && ref.repo && armedRepos.has(repoKey(ref.repo))) {
      live.push(ref)
      continue
    }
    discovery.push(ref)
  }
  return { live, discovery }
}

/** Kind-qualified freshness identity: `pr:owner/repo#number`,
 * `run:owner/repo#id`. PR and run id spaces are independent, so an
 * unqualified key would let a fresh PR satisfy a missing run (or vice versa).
 * Published once per accepted completion, never unioned across operations. */
export const freshKeyFor = (repo: RepoRef, kind: "pr" | "run", number: number): string =>
  `${kind}:${repoKey(repo)}#${number}`

export const freshKeysFor = (entities: readonly Entity[]): Set<string> => {
  const keys = new Set<string>()
  for (const entity of entities) {
    if (entity.kind === "pr") keys.add(freshKeyFor(entity.repo, "pr", entity.number))
    else if (entity.kind === "run") keys.add(freshKeyFor(entity.repo, "run", entity.id))
  }
  return keys
}

export interface SafetyInput {
  chains: readonly Chain[]
  /** Chain keys pill-eligible this refresh (superset: eligible incl. cap overflow). */
  eligibleKeys: ReadonlySet<string>
  /** Pinned chain key, if any. */
  pinnedKey: string | undefined
  /** Armed PRs (always kind pr). */
  armed: readonly { repo: RepoRef; number: number }[]
  /** Head-change recovery targets (always kind pr). */
  recovery: readonly { repo: RepoRef; number: number }[]
  /** Branch-linked creation links, kinds as extracted. */
  creation: readonly TieredRef[]
  /** Explicit refresh target (always kind pr). */
  target: { repo: RepoRef; number: number } | undefined
}

/**
 * Concrete safety refs: every identity the freshness gate may require,
 * synthesized explicitly because protection alone never sends anything.
 * Armed PRs, recovery targets, the explicit target, pinned/eligible members
 * (prs, issues, runs by id), and same-repo/current-head runs of armed PRs.
 * Stable order, deduplicated by repo+kind+number.
 */
export const safetyRefs = (input: SafetyInput): TieredRef[] => {
  const seen = new Set<string>()
  const out: TieredRef[] = []
  const push = (repo: RepoRef, number: number, kind: TieredRef["kind"]): void => {
    const key = `${repoKey(repo)}#${kind ?? ""}${number}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ repo, number, kind: kind ?? undefined, tier: "user" })
  }
  for (const entry of input.armed) push(entry.repo, entry.number, "pr")
  for (const entry of input.recovery) push(entry.repo, entry.number, "pr")
  if (input.target) push(input.target.repo, input.target.number, "pr")
  for (const ref of input.creation) {
    if (!ref.repo) continue
    const key = `${repoKey(ref.repo)}#${ref.kind ?? ""}${ref.number}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ref)
  }
  const members = (chain: Chain): void => {
    for (const pull of chain.prs) push(pull.repo, pull.number, "pr")
    for (const issue of chain.issues) push(issue.repo, issue.number, "issue")
    for (const run of chain.runs) push(run.repo, run.id, "run")
  }
  if (input.pinnedKey !== undefined) {
    const pinned = input.chains.find((chain) => chain.key === input.pinnedKey)
    if (pinned) members(pinned)
  }
  // Armed-head runs ride along regardless of eligibility: an armed PR on a
  // chain that never became eligible still needs fresh run evidence, or the
  // freshness gate would block its merge forever.
  for (const entry of input.armed) {
    for (const chain of input.chains) {
      const pull = chain.prs.find(
        (candidate) => candidate.number === entry.number && repoKey(candidate.repo) === repoKey(entry.repo),
      )
      if (!pull) continue
      for (const run of chain.runs)
        if (repoKey(run.repo) === repoKey(pull.repo) && run.headSha === pull.headSha) push(run.repo, run.id, "run")
    }
  }
  for (const chain of input.chains) {
    if (!input.eligibleKeys.has(chain.key)) continue
    members(chain)
  }
  return out
}

/** Combined currency check for post-await boundaries: same session attempt,
 * same refresh generation, and this operation still the latest sent one.
 * A newer hydrate operation (either pipeline) started while awaiting means
 * this completion's evidence is superseded — even when the generation and
 * session still match, as two debounce fires can share both. */
export const isOperationCurrent = (
  sessionOk: boolean,
  gen: number,
  currentGen: number,
  opId: number,
  latestOp: number,
): boolean => sessionOk && gen === currentGen && opId === latestOp

/** Settlement decision for one hydrate operation: commit only when this
 * operation is still the latest sent one and the pipeline is current.
 * Concurrent same-generation completions (A/B in either order) resolve here:
 * the loser releases its reservations and merges nothing. Pure, so the A/B
 * reverse-completion order is unit-testable without the window. */
export const shouldSettle = (opId: number, latestOp: number, current: boolean): boolean =>
  opId === latestOp && current

/** Freshness evidence for one accepted hydrate operation. Merge driving may
 * only use safety evidence from a single operation that is still the latest
 * accepted one — never a union across operations. */
export interface FreshSafety {
  op: number
  sessionKey: string
  keys: ReadonlySet<string>
}

/** Gate for armed-merge driving: every required key (kind-qualified armed PR
 * plus its current-head runs) must be fresh in the latest accepted operation
 * for this session. Omitted, failed, or superseded evidence fails closed. */
export const armedMergeEligible = (
  fresh: FreshSafety | undefined,
  sessionKey: string,
  currentOp: number,
  required: readonly string[],
): boolean =>
  fresh !== undefined &&
  fresh.sessionKey === sessionKey &&
  fresh.op === currentOp &&
  required.every((key) => fresh.keys.has(key))
