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
  /** Provider-defined identity and increasing invocation order for one workflow series. */
  series?: { key: string; sequence: number }
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

/** Whether an open PR should show the conflict-specific glyph. */
export const prConflicted = (pull: PullEntity): boolean => pull.state === "open" && pull.mergeState === "conflict"

export const latestRuns = (runs: readonly RunEntity[]): RunEntity[] => {
  const independent: RunEntity[] = []
  const grouped = new Map<string, { sequence: number; runs: RunEntity[] }>()
  for (const run of runs) {
    if (!run.series?.key || !Number.isFinite(run.series.sequence)) {
      independent.push(run)
      continue
    }
    const key = `${repoKey(run.repo)}\n${run.headSha}\n${run.series.key}`
    const previous = grouped.get(key)
    if (!previous || run.series.sequence > previous.sequence) {
      grouped.set(key, { sequence: run.series.sequence, runs: [run] })
      continue
    }
    if (run.series.sequence === previous.sequence) previous.runs.push(run)
  }
  const byIdentity = (a: RunEntity, b: RunEntity): number =>
    repoKey(a.repo).localeCompare(repoKey(b.repo)) || a.headSha.localeCompare(b.headSha) || a.id - b.id
  return [
    ...independent.toSorted(byIdentity),
    ...[...grouped.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .flatMap(([, group]) => group.runs.toSorted(byIdentity)),
  ]
}

/** The displayed/diagnostic representative run follows workflow sequence, not completion time. */
export const latestRun = (runs: readonly RunEntity[]): RunEntity | undefined => latestRuns(runs)[0]

const currentRunsForPull = (chain: Chain, pull: PullEntity): RunEntity[] => latestRuns(
  chain.runs.filter((run) => run.headSha === pull.headSha && repoKey(run.repo) === repoKey(pull.repo)),
)

/** Whether a PR can merge right now: open, checks green, no conflicts, no
 * outstanding change requests. Defaults to the chain's lead; callers pass an
 * explicit pull to check another member of the chain. Unknown states (entries
 * hydrated by older code) don't block — they fall back to the checks. No
 * evidence, no merge: zero known runs merges only on the provider's explicit
 * clean state, never on absence of data. Superseded runs in a known series do
 * not block; unrelated runs and runs without series metadata remain independent. */
export const mergeReady = (chain: Chain, pull = chain.prs[0], waitForAllStatusChecks = true): boolean => {
  if (!pull || pull.state !== "open") return false
  const currentRuns = currentRunsForPull(chain, pull)
  if (!currentRuns.every((run) => run.status === "succeeded")) return false
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
  if (currentRuns.length === 0 && pull.mergeState !== "ready") return false
  return true
}

/** Why a PR can't merge yet — the disabled button's tooltip. Defaults to the
 * chain's lead; callers pass an explicit pull to explain another member. */
export const mergeWhy = (chain: Chain, pull = chain.prs[0], waitForAllStatusChecks = true): string => {
  const currentRuns = pull ? currentRunsForPull(chain, pull) : []
  const failed = currentRuns.find((run) => run.status === "failed")
  if (failed) return `checks failed (run #${failed.id})`
  if (currentRuns.some((run) => run.status === "queued" || run.status === "running")) return "checks still running"
  const cancelled = currentRuns.find((run) => run.status === "cancelled")
  if (cancelled) return `checks cancelled (run #${cancelled.id})`
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
  if (currentRuns.length === 0 && pull?.mergeState !== "ready")
    return "no checks on record for the current head"
  return "not ready"
}

/** Whether a not-ready PR is hard-blocked (red) rather than merely waiting
 * (amber): a failed or cancelled check on the current head, failed/cancelled
 * status contexts, requested changes, conflicts, or branch-rule blocks. Running
 * checks, unavailable snapshots, and missing evidence stay amber — they can
 * still turn green without intervention. Returns false for ready or non-open
 * PRs, so callers check it only as the red branch before the amber fallback. */
export const mergeFailed = (chain: Chain, pull = chain.prs[0], waitForAllStatusChecks = true): boolean => {
  if (!pull || pull.state !== "open") return false
  if (mergeReady(chain, pull, waitForAllStatusChecks)) return false
  const currentRuns = currentRunsForPull(chain, pull)
  if (currentRuns.some((run) => run.status === "failed" || run.status === "cancelled")) return true
  if (waitForAllStatusChecks && pull.statusChecks?.state === "available" && pull.statusChecks.headSha === pull.headSha) {
    if (pull.statusChecks.contexts.some((context) => context.status === "failed" || context.status === "cancelled")) return true
  }
  if (pull.reviewState === "changes_requested") return true
  if (pull.mergeState === "conflict" || pull.mergeState === "blocked") return true
  return false
}

/** Confirmation fragment for merge/arm dialogs when review activity exists
 * without an approval (comments, dismissed, or otherwise non-decisive
 * reviews). The provider does not block these, so merging stays allowed —
 * but the dialog names it so the approval gap is a conscious accept. */
export const pendingReviewNotice = (pull: PullEntity): string | undefined =>
  pull.reviewState === "pending" ? "reviews are pending (no approval on record)" : undefined

/** Pill eligibility — what deserves the composer's highest-commitment surface.
 * Only the session's own work pills, one pill per chain (pinned first, capped
 * for display): a PR from the session's repository on the session's branch —
 * repo-scoped, since a foreign PR can share a branch name; or a PR whose head
 * SHA equals the session checkout's HEAD — a push from any local branch name
 * counts as own work. `created` is the sticky memory of PRs this session
 * previously owned (branch/SHA matched at creation time): sequential
 * multi-PR sessions keep every created PR pilled after switching branches,
 * while either ownership match holds for live work. Own work remains eligible
 * after merging while it is not closed; SHA-only ownership lapses if local
 * HEAD advances beyond the PR head. `pillPick` ranks the eligible chains.
 * Everything else is sidebar material: other branches' PRs (mention is not
 * intent — see the PR #5 recruiting incident), issue-only chains,
 * closed-without-merge work, settled run-only chains. */
export const pillEligible = (
  chain: Chain,
  ctx: {
    sessionBranch?: string
    sessionRepo?: RepoRef
    sessionHeadSha?: string
    armed?: readonly { repo: RepoRef; number: number }[]
    created?: ReadonlySet<string>
  } = {},
): boolean => {
  // The session's own work: repository-scoped, since a foreign PR can share a
  // branch name (the PR #5 incident itself was cross-repo). A HEAD-SHA match
  // covers pushing the PR's branch from a differently-named local branch.
  if (
    ctx.sessionRepo !== undefined &&
    chain.prs.some(
      (pull) =>
        pull.state !== "closed" &&
        repoKey(pull.repo) === repoKey(ctx.sessionRepo!) &&
        ((ctx.sessionBranch !== undefined && pull.headBranch === ctx.sessionBranch) ||
          (ctx.sessionHeadSha !== undefined && pull.headSha === ctx.sessionHeadSha)),
    )
  )
    return true
  // Sticky session-created memory: a PR this session previously owned stays
  // eligible after the checkout moves on to the next PR's branch. Closed
  // work still drops out; keys are repo-scoped entity keys, so a foreign
  // PR can never ride along.
  if (
    ctx.created !== undefined &&
    chain.prs.some((pull) => pull.state !== "closed" && ctx.created!.has(entityKey(pull)))
  )
    return true
  return false
}

/** Fresh worktree gate: a new session still on its base branch with zero
 * deliberate transcript refs shows an empty sidebar and no pill. v1 base names
 * are hardcoded `main`/`master` (case-sensitive); detached HEAD (`""`) stays
 * non-fresh — it is already empty via the existing no-branch path. */
export const isFreshBaseSession = (
  sessionBranch: string,
  deliberateRefCount: number,
  baseNames: readonly string[] = ["main", "master"],
): boolean => deliberateRefCount === 0 && baseNames.includes(sessionBranch)

/** Sidebar pin: member identity survives lead changes. PR pins carry
 * `{repo, number}` (kind `pr` implied); issue/run-only groups pin their lead
 * member (`kind` explicit, since `#42` alone is ambiguous); anything else
 * falls back to the chain key for older pins. Empty pin = unpinned. `owner`
 * is the pinning session: only it may expire the pin, so another session in
 * the same repository can never erase it. */
export interface Pin {
  repo?: RepoRef
  number?: number
  kind?: "pr" | "issue" | "run"
  key?: string
  owner?: string
}

export const pinForChain = (chain: Chain): Pin => {
  const open = chain.prs.find((pull) => pull.state === "open" || pull.state === "draft") ?? chain.prs[0]
  if (open) return { repo: open.repo, number: open.number }
  const issue = chain.issues[0]
  if (issue) return { repo: issue.repo, number: issue.number, kind: "issue" }
  const run = chain.runs[0]
  if (run) return { repo: run.repo, number: run.id, kind: "run" }
  return { key: chain.key }
}

export const samePin = (a: Pin, b: Pin): boolean => {
  if (a.number !== undefined && b.number !== undefined && a.repo && b.repo)
    return (
      a.number === b.number &&
      (a.kind ?? "pr") === (b.kind ?? "pr") &&
      repoKey(a.repo) === repoKey(b.repo)
    )
  return a.key !== undefined && a.key === b.key
}

/** Resolve the pinned chain: member identity wins (any state, any kind —
 * an explicit pin bypasses eligibility); chain-key fallback covers pins
 * written before member identity existed. */
export const pinnedChain = (chains: readonly Chain[], pin: Pin): Chain | undefined => {
  if (pin.number !== undefined && pin.repo) {
    const kind = pin.kind ?? "pr"
    return chains.find((chain) => {
      if (kind === "pr") return chain.prs.some((pull) => pull.number === pin.number && repoKey(pull.repo) === repoKey(pin.repo!))
      if (kind === "issue")
        return chain.issues.some((issue) => issue.number === pin.number && repoKey(issue.repo) === repoKey(pin.repo!))
      return chain.runs.some((run) => run.id === pin.number && repoKey(run.repo) === repoKey(pin.repo!))
    })
  }
  if (pin.key !== undefined) return chains.find((chain) => chain.key === pin.key)
  return undefined
}

/** The pill's lead chain, among the eligible pool: the worst-toned PR chain
 * outranks recency (failing checks, conflicts, blocked merges, or a requested
 * review beat a calm newer one); otherwise the most recently updated open/draft PR chain; then
 * attention-bearing run-only chains (a discovered failure); then the newest
 * merged chain as the terminal pill; settled run-bearing chains are the last
 * resort. An issue-only chain never wins — there is nothing to show. */
export const pillPick = (
  chains: readonly Chain[],
  waitForAllStatusChecks = true,
): { chain: Chain; reason: "danger" | "newest" | "runs-only" | "merged"; considered: number } | undefined => {
  const byNewest = (a: { updatedAt: number }, b: { updatedAt: number }): number => b.updatedAt - a.updatedAt
  const prChains = chains.filter((chain) => chain.prs.some((pull) => pull.state === "open" || pull.state === "draft")).toSorted(byNewest)
  const danger = prChains.find((chain) => chainTone(chain, waitForAllStatusChecks) === "danger")
  if (danger) return { chain: danger, reason: "danger", considered: prChains.length }
  if (prChains[0]) return { chain: prChains[0], reason: "newest", considered: prChains.length }
  const attention = chains
    .filter((chain) =>
      chain.prs.length === 0 &&
      latestRuns(chain.runs).some((run) => run.status === "queued" || run.status === "running" || run.status === "failed"),
    )
    .toSorted(byNewest)
  if (attention[0]) return { chain: attention[0], reason: "runs-only", considered: attention.length }
  const mergedChains = chains.filter((chain) => chain.prs.some((pull) => pull.state === "merged")).toSorted(byNewest)
  if (mergedChains[0]) return { chain: mergedChains[0], reason: "merged", considered: mergedChains.length }
  const runChains = chains.filter((chain) => chain.runs.length > 0).toSorted(byNewest)
  if (runChains[0]) return { chain: runChains[0], reason: "runs-only", considered: runChains.length }
  return undefined
}

/**
 * Every pill above the composer, in display order: the same priority as
 * `pillPick` (danger open/draft PRs first, then calm open/draft PRs newest-first,
 * then attention-bearing run-only chains, then merged chains, then settled
 * run-bearing chains), but returning the whole list instead of just the lead.
 * `pillPick` is the first element of this list. An issue-only chain never
 * appears — there is nothing to show. Deduplicated by chain key; callers cap
 * the length for display.
 */
export const pillPicks = (
  chains: readonly Chain[],
  waitForAllStatusChecks = true,
): { chain: Chain; reason: "danger" | "newest" | "runs-only" | "merged" }[] => {
  const byNewest = (a: { updatedAt: number }, b: { updatedAt: number }): number => b.updatedAt - a.updatedAt
  const seen = new Set<string>()
  const out: { chain: Chain; reason: "danger" | "newest" | "runs-only" | "merged" }[] = []
  const push = (chain: Chain, reason: "danger" | "newest" | "runs-only" | "merged"): void => {
    if (seen.has(chain.key)) return
    seen.add(chain.key)
    out.push({ chain, reason })
  }
  const prChains = chains.filter((chain) => chain.prs.some((pull) => pull.state === "open" || pull.state === "draft")).toSorted(byNewest)
  for (const chain of prChains.toSorted((a, b) => {
    const dangerA = chainTone(a, waitForAllStatusChecks) === "danger" ? 0 : 1
    const dangerB = chainTone(b, waitForAllStatusChecks) === "danger" ? 0 : 1
    return dangerA - dangerB || b.updatedAt - a.updatedAt
  }))
    push(chain, chainTone(chain, waitForAllStatusChecks) === "danger" ? "danger" : "newest")
  const attention = chains
    .filter((chain) =>
      chain.prs.length === 0 &&
      latestRuns(chain.runs).some((run) => run.status === "queued" || run.status === "running" || run.status === "failed"),
    )
    .toSorted(byNewest)
  for (const chain of attention) push(chain, "runs-only")
  const mergedChains = chains.filter((chain) => chain.prs.some((pull) => pull.state === "merged")).toSorted(byNewest)
  for (const chain of mergedChains) push(chain, "merged")
  const runChains = chains.filter((chain) => chain.runs.length > 0).toSorted(byNewest)
  for (const chain of runChains) push(chain, "runs-only")
  return out
}

/**
 * The pill dropdown lists pinned-first: a pinned chain leads even when it is
 * ineligible or ranked past the eligible cap, with eligible chains filling the
 * remaining slots (capped at three rows total, deduplicated by chain key).
 */
export const menuChains = (
  picked: { chain: Chain; reason: string } | undefined,
  eligible: readonly Chain[],
): readonly Chain[] => {
  const pinned = picked?.reason === "pinned" ? picked.chain : undefined
  if (!pinned) return eligible.slice(0, 3)
  return [pinned, ...eligible.filter((chain) => chain.key !== pinned.key).slice(0, 2)]
}

/** A pull request Muninn is driving to merge: armed locally by the user, merged
 * by Muninn's refresh cycle — never delegated to the forge's own auto-merge. */
export interface ArmedEntry {
  repo: RepoRef
  number: number
  method: "merge" | "squash" | "rebase"
  /** Distinguishes a newly re-armed user consent from an in-flight old request. */
  armID?: string
}

export const staleHeadRetryEligible = (input: {
  via: "manual" | "when-ready"
  headChanged: boolean
  armed: boolean
  refreshSucceeded: boolean
  inFlight: boolean
  rejectedHeadSha: string
  currentHeadSha?: string
  ready: boolean
}): boolean =>
  input.via === "when-ready" &&
  input.headChanged &&
  input.armed &&
  input.refreshSucceeded &&
  !input.inFlight &&
  input.currentHeadSha !== undefined &&
  input.currentHeadSha !== input.rejectedHeadSha &&
  input.ready

export const sessionAttemptCurrent = (
  attempt: { id: string; directory: string } | undefined,
  current: { id: string; directory: string } | undefined,
): boolean => !!attempt && !!current && attempt.id === current.id && attempt.directory === current.directory

export const targetRefreshConfirmed = (input: {
  refreshSucceeded: boolean
  targetReturned: boolean
  targetUnresolved: boolean
}): boolean => input.refreshSucceeded && input.targetReturned && !input.targetUnresolved

export const staleHeadEvidenceUsable = (input: {
  rejectedHeadSha: string
  candidateHeadSha: string
  confirmedHeadSha?: string
}): boolean =>
  input.confirmedHeadSha !== undefined &&
  input.confirmedHeadSha !== input.rejectedHeadSha &&
  input.candidateHeadSha === input.confirmedHeadSha

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
 * Worst-state helper for pill and history tones: failing runs, conflicts,
 * requested changes, and blocked merges are danger; pending and in-flight work
 * are warning; a fully green chain reads as success.
 */
export const chainTone = (chain: Chain, waitForAllStatusChecks = true): "success" | "warning" | "danger" | undefined => {
  const lead = chain.prs.find((pull) => pull.state === "open" || pull.state === "draft") ?? chain.prs[0]
  const relevantRuns = lead
    ? currentRunsForPull(chain, lead)
    : chain.prs.length === 0
      ? latestRuns(chain.runs)
      : []
  if (relevantRuns.some((run) => run.status === "failed")) return "danger"
  if (lead?.mergeState === "conflict" || lead?.reviewState === "changes_requested") return "danger"
  if (lead?.state === "open" && lead.mergeState === "blocked") return "danger"
  if (relevantRuns.some((run) => run.status === "running" || run.status === "queued")) return "warning"
  if (lead?.state === "open" && lead.mergeState === "pending") return "warning"
  if (lead?.state === "open" && mergeReady(chain, lead, waitForAllStatusChecks)) return "success"
  if (lead?.state === "merged") return "success"
  if (chain.prs.length === 0 && relevantRuns.some((run) => run.status === "succeeded")) return "success"
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
