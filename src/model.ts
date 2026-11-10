/**
 * The provider-agnostic model Muninn's UI renders. Providers (GitHub today,
 * GitLab or a tracker tomorrow) hydrate these; the GUI never sees provider
 * specifics beyond a `provider` mark and a repo slug.
 */

/** Repositories Muninn knows about, parsed from a git remote URL. */
export interface RepoRef {
  host: string
  owner: string
  repo: string
}

export type ProviderID = string

export type Kind = "issue" | "pr" | "run"

export type IssueState = "open" | "closed"

export type PullState = "open" | "draft" | "merged" | "closed"

/** Mergeability per the provider (GitHub: `mergeable` + `mergeable_state`). null = unknown (older cache entries). */
export type MergeState = "ready" | "pending" | "blocked" | "conflict"

/** Review outcome, latest review per reviewer. null = no reviews or not fetched. */
export type ReviewState = "approved" | "changes_requested" | "pending"

export type AutoMergeMethod = "merge" | "squash" | "rebase"

/** CI run states, the only thing a run row shows. */
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled"

export interface StatusCheckSnapshot {
  headSha: string
  state: "available" | "unavailable" | "unsupported"
  contexts: { name: string; status: RunStatus }[]
}

/**
 * A reference extracted from session text: `#1043`, `PR 4821`, `run 18402`, a pasted
 * URL, or `owner/repo#7`. `kind` is omitted when the text does not say (`#1043` could
 * be either); hydration resolves it and unknown numbers are dropped.
 */
export interface Ref {
  number: number
  kind?: Extract<Kind, "issue" | "pr" | "run">
  /** Omitted when the reference belongs to the session's own repository. */
  repo?: RepoRef
}

interface Base {
  /** The provider that hydrated this entity. */
  readonly provider: ProviderID
  /** When the entity last changed upstream; chains order by this. Epoch milliseconds. */
  readonly updatedAt: number
  readonly url: string
  readonly repo: RepoRef
}

export interface IssueEntity extends Base {
  kind: "issue"
  number: number
  title: string
  state: IssueState
}

export interface Check {
  name: string
  status: RunStatus
}

export interface RunEntity extends Base {
  kind: "run"
  /** The provider's run id, shown as `run #18404`. */
  id: number
  name: string
  headBranch: string
  headSha: string
  status: RunStatus
  /** Individual checks of the run, for the expanded row. */
  checks: Check[]
  /** Pull requests this run belongs to, per the provider. */
  pullRequests: number[]
  url: string
  updatedAt: number
}

export interface PullEntity extends Base {
  kind: "pr"
  number: number
  title: string
  state: PullState
  /** Merge timestamp from the provider, in epoch milliseconds. */
  mergedAt?: number
  headBranch: string
  baseBranch: string
  /** Issue numbers the pull request closes, parsed from its body. */
  closes: number[]
  headSha: string
  /** Provider's node id, for graph mutations (arm auto-merge). Older cached entries predate it. */
  nodeId?: string
  mergeState?: MergeState | null
  reviewState?: ReviewState | null
  /** The provider's auto-merge: armed with this method, or null when off. */
  autoMerge?: AutoMergeMethod | null
  /** Commit statuses and check-runs discovered for headSha; older cache entries omit it. */
  statusChecks?: StatusCheckSnapshot
}

export type Entity = IssueEntity | PullEntity | RunEntity

/**
 * One history card: the pull request(s) an issue's work produced, their CI runs —
 * or any subset. `key` is stable across refreshes; `updatedAt` orders the cards.
 */
export interface Chain {
  key: string
  /** Lead pull request (branch match, else most recent), first of `prs`. */
  prs: PullEntity[]
  /** Issues connected to the chain's PRs via closing keywords. */
  issues: IssueEntity[]
  /** Newest first; every run whose head SHA belongs to one of the chain's PRs. */
  runs: RunEntity[]
  updatedAt: number
}

export const repoKey = (repo: RepoRef): string => `${repo.host}/${repo.owner}/${repo.repo}`

/** Resolve all PRs a run belongs to, using explicit metadata, SHA, then unique branch. */
export const pullsForRun = (run: RunEntity, pulls: readonly PullEntity[]): PullEntity[] => {
  const sameRepoPulls = pulls.filter((pull) => repoKey(pull.repo) === repoKey(run.repo))
  if (run.pullRequests.length > 0) return sameRepoPulls.filter((pull) => run.pullRequests.includes(pull.number))
  const bySha = sameRepoPulls.filter((pull) => pull.headSha === run.headSha)
  if (bySha.length > 0) return bySha
  const byBranch = sameRepoPulls.filter((pull) => pull.headBranch === run.headBranch)
  return byBranch.length === 1 ? byBranch : []
}

/** Resolve the most relevant single PR for labels that can display only one. */
export const pullForRun = (run: RunEntity, pulls: readonly PullEntity[]): PullEntity | undefined =>
  pullsForRun(run, pulls)[0]

export const refKey = (ref: Ref): string =>
  `${ref.repo ? `${ref.repo.host}/${ref.repo.owner}/${ref.repo.repo}` : "@"}#${ref.kind ?? ""}${ref.number}`

/** The store/dedupe key for a hydrated entity: repo-scoped, runs by id. */
export const entityKey = (entity: Entity): string =>
  `${repoKey(entity.repo)}#${entity.kind}${entity.kind === "run" ? entity.id : entity.number}`

/** Whether a PR can merge right now: open, checks green, no conflicts, no
 * outstanding change requests. Defaults to the chain's lead; callers pass an
 * explicit pull to check another member of the chain. Unknown states (entries
 * hydrated by older code) don't block — they fall back to the checks. No
 * evidence, no merge: zero known runs merges only on the provider's explicit
 * clean state, never on absence of data. */
export const mergeReady = (chain: Chain, pull = chain.prs[0], waitForAllStatusChecks = true): boolean => {
  if (!pull || pull.state !== "open") return false
  if (!chain.runs.filter((run) => run.headSha === pull.headSha).every((run) => run.status === "succeeded")) return false
  if (waitForAllStatusChecks) {
    const snapshot = pull.statusChecks
    if (!snapshot || snapshot.headSha !== pull.headSha || snapshot.state === "unavailable") return false
    if (snapshot.state === "available" && !snapshot.contexts.every((context) => context.status === "succeeded")) return false
  }
  if (pull.reviewState === "changes_requested" || pull.mergeState === "conflict") return false
  if (pull.mergeState && pull.mergeState !== "ready") return false
  // No evidence, no merge: a green run on this PR's current head, or the
  // provider's explicit clean state. Stale runs from earlier commits neither
  // block nor count as evidence, and a minimal forge with no run discovery and
  // no merge state is never auto-mergeable (accepted: GitHub always hydrates
  // state, so its clean `ready` is itself the evidence when no runs are known).
  if (!chain.runs.some((run) => run.headSha === pull.headSha) && pull.mergeState !== "ready") return false
  return true
}

/** Why a PR can't merge yet — the disabled button's tooltip. Defaults to the
 * chain's lead; callers pass an explicit pull to explain another member. */
export const mergeWhy = (chain: Chain, pull = chain.prs[0], waitForAllStatusChecks = true): string => {
  const currentRuns = chain.runs.filter((run) => run.headSha === pull?.headSha)
  const failed = currentRuns.find((run) => run.status === "failed")
  if (failed) return `checks failed (run #${failed.id})`
  if (currentRuns.some((run) => run.status === "queued" || run.status === "running")) return "checks still running"
  if (waitForAllStatusChecks && pull) {
    const snapshot = pull.statusChecks
    if (!snapshot || snapshot.headSha !== pull.headSha || snapshot.state === "unavailable") return "status checks unavailable"
    if (snapshot.state === "available") {
      if (snapshot.contexts.some((context) => context.status === "failed")) return "status checks failed"
      if (snapshot.contexts.some((context) => context.status === "queued" || context.status === "running")) return "status checks still running"
      if (snapshot.contexts.some((context) => context.status === "cancelled")) return "status checks did not succeed"
    }
  }
  if (pull?.reviewState === "changes_requested") return "changes requested"
  if (pull?.mergeState === "conflict") return "merge conflicts with the base branch"
  if (pull?.mergeState === "blocked") return "blocked by branch rules or a missing review"
  if (!pull || pull.state !== "open") return "pull request is not open"
  // Mirror the evidence gate: this is the chain that just lost merge readiness.
  if (!chain.runs.some((run) => run.headSha === pull?.headSha) && pull?.mergeState !== "ready")
    return "no checks on record for the current head"
  return "not ready"
}

/** Pill eligibility — what deserves the composer's highest-commitment surface.
 * Eligible: the session's own work (a PR from the session's repository on the
 * session's branch — repo-scoped, since a foreign PR can share a branch name;
 * it stays shown after merging; the pill represents the session's work and
 * moves on only when a newer PR appears, which `pillPick`'s ranking handles)
 * and anything needing attention now: CI queued/running/failed on current heads
 * (status-derived, so a discovered failure pills with no mention at all) and
 * an armed PR pending merge, matched by repository and number. Everything else
 * is sidebar material: other branches' PRs (mention is not intent — see the
 * PR #5 recruiting incident), issue-only chains, closed-without-merge work,
 * settled run-only chains. */
export const pillEligible = (
  chain: Chain,
  ctx: {
    sessionBranch?: string
    sessionRepo?: RepoRef
    armed?: readonly { repo: RepoRef; number: number }[]
  } = {},
): boolean => {
  // The session's own work: repository-scoped, since a foreign PR can share a
  // branch name (the PR #5 incident itself was cross-repo).
  if (
    ctx.sessionBranch !== undefined &&
    ctx.sessionRepo !== undefined &&
    chain.prs.some(
      (pull) =>
        pull.headBranch === ctx.sessionBranch &&
        pull.state !== "closed" &&
        repoKey(pull.repo) === repoKey(ctx.sessionRepo!),
    )
  )
    return true
  // CI needing attention, scoped to current work: runs on open/draft PR heads,
  // or any run when the chain has no PRs (a discovered failure pills with no
  // mention at all). Stale runs — earlier heads, merged/closed PRs — are
  // history, not attention.
  const current = chain.prs.length === 0
    ? chain.runs
    : chain.runs.filter((run) =>
        chain.prs.some((pull) => (pull.state === "open" || pull.state === "draft") && pull.headSha === run.headSha),
      )
  if (current.some((run) => run.status === "queued" || run.status === "running" || run.status === "failed"))
    return true
  const armed = ctx.armed ?? []
  if (
    armed.length > 0 &&
    chain.prs.some(
      (pull) =>
        pull.state === "open" &&
        armed.some((entry) => entry.number === pull.number && repoKey(entry.repo) === repoKey(pull.repo)),
    )
  )
    return true
  return false
}

/** The pill's lead chain, among the eligible pool: the worst-toned PR chain
 * outranks recency (failing checks, conflicts, or a requested review beat a calm
 * newer one); otherwise the most recently updated open/draft PR chain; then
 * attention-bearing run-only chains (a discovered failure); then the newest
 * merged chain as the terminal pill; settled run-bearing chains are the last
 * resort. An issue-only chain never wins — there is nothing to show. */
export const pillPick = (
  chains: readonly Chain[],
): { chain: Chain; reason: "danger" | "newest" | "runs-only" | "merged"; considered: number } | undefined => {
  const byNewest = (a: { updatedAt: number }, b: { updatedAt: number }): number => b.updatedAt - a.updatedAt
  const prChains = chains.filter((chain) => chain.prs.some((pull) => pull.state === "open" || pull.state === "draft")).toSorted(byNewest)
  const danger = prChains.find((chain) => chainTone(chain) === "danger")
  if (danger) return { chain: danger, reason: "danger", considered: prChains.length }
  if (prChains[0]) return { chain: prChains[0], reason: "newest", considered: prChains.length }
  const attention = chains
    .filter((chain) =>
      chain.prs.length === 0 &&
      chain.runs.some((run) => run.status === "queued" || run.status === "running" || run.status === "failed"),
    )
    .toSorted(byNewest)
  if (attention[0]) return { chain: attention[0], reason: "runs-only", considered: attention.length }
  const mergedChains = chains.filter((chain) => chain.prs.some((pull) => pull.state === "merged")).toSorted(byNewest)
  if (mergedChains[0]) return { chain: mergedChains[0], reason: "merged", considered: mergedChains.length }
  const runChains = chains.filter((chain) => chain.runs.length > 0).toSorted(byNewest)
  if (runChains[0]) return { chain: runChains[0], reason: "runs-only", considered: runChains.length }
  return undefined
}

/** A pull request Muninn is driving to merge: armed locally by the user, merged
 * by Muninn's refresh cycle — never delegated to the forge's own auto-merge. */
export interface ArmedEntry {
  repo: RepoRef
  number: number
  method: "merge" | "squash" | "rebase"
}

/** Armed entries whose chain is mergeable right now. Providers without merge or
 * review state fall back to checks — which must be on record (no evidence, no
 * merge), so a state-less forge without known runs never drives an armed merge. */
export const armedTargets = (
  entries: readonly ArmedEntry[],
  chains: readonly Chain[],
  waitForAllStatusChecks = true,
): { pull: PullEntity; chain: Chain; method: ArmedEntry["method"] }[] => {
  const out: { pull: PullEntity; chain: Chain; method: ArmedEntry["method"] }[] = []
  for (const entry of entries) {
    const chain = chains.find((candidate) =>
      candidate.prs.some(
        (pull) => pull.state === "open" && pull.number === entry.number && repoKey(pull.repo) === repoKey(entry.repo),
      ),
    )
    if (!chain) continue
    const pull = chain.prs.find(
      (candidate) => candidate.number === entry.number && repoKey(candidate.repo) === repoKey(entry.repo),
    )
    if (pull && mergeReady(chain, pull, waitForAllStatusChecks)) out.push({ pull, chain, method: entry.method })
  }
  return out
}

/**
 * Worst-state helper for pill tones: failing runs and conflicted/revoked work
 * outrank everything; blocked and in-flight work read as warning; a fully green
 * chain reads as success.
 */
export const chainTone = (chain: Chain): "success" | "warning" | "danger" | undefined => {
  const lead = chain.prs.find((pull) => pull.state === "open" || pull.state === "draft") ?? chain.prs[0]
  const relevantRuns = lead
    ? chain.runs.filter((run) => run.headSha === lead.headSha)
    : chain.prs.length === 0
      ? chain.runs
      : []
  if (relevantRuns.some((run) => run.status === "failed")) return "danger"
  if (lead?.mergeState === "conflict" || lead?.reviewState === "changes_requested") return "danger"
  if (relevantRuns.some((run) => run.status === "running" || run.status === "queued")) return "warning"
  if (lead?.state === "open" && (lead.mergeState === "blocked" || lead.mergeState === "pending")) return "warning"
  if (lead?.state === "open" && mergeReady(chain, lead)) return "success"
  if (lead?.state === "merged") return "success"
  if (chain.prs.length === 0 && chain.runs.some((run) => run.status === "succeeded")) return "success"
  return undefined
}

/** The RPC transport encodes responses as strict JSON: a property whose value
 * is `undefined` (zod's optional leaves the key present) fails the whole
 * response with "Expected JSON value". Deep-remove those properties at the
 * boundary. Null, 0, "" and false are JSON — they stay. */
export const jsonReady = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map((item) => jsonReady(item)) as unknown as T
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = jsonReady(item)
    return out as T
  }
  return value
}
