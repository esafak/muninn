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

export const refKey = (ref: Ref): string =>
  `${ref.repo ? `${ref.repo.host}/${ref.repo.owner}/${ref.repo.repo}` : "@"}#${ref.kind ?? ""}${ref.number}`

/** Whether the chain's lead PR can merge right now: open, checks green, no
 * conflicts, no outstanding change requests. Unknown states (entries hydrated
 * by older code) don't block — they fall back to the checks. */
export const mergeReady = (chain: Chain): boolean => {
  const lead = chain.prs[0]
  if (!lead || lead.state !== "open") return false
  if (!chain.runs.every((run) => run.status === "succeeded")) return false
  if (lead.reviewState === "changes_requested" || lead.mergeState === "conflict") return false
  if (lead.mergeState && lead.mergeState !== "ready") return false
  return true
}

/** Why the lead PR can't merge yet — the disabled button's tooltip. */
export const mergeWhy = (chain: Chain): string => {
  const lead = chain.prs[0]
  const failed = chain.runs.find((run) => run.status === "failed")
  if (failed) return `checks failed (run #${failed.id})`
  if (chain.runs.some((run) => run.status === "queued" || run.status === "running")) return "checks still running"
  if (lead?.reviewState === "changes_requested") return "changes requested"
  if (lead?.mergeState === "conflict") return "merge conflicts with the base branch"
  if (lead?.mergeState === "blocked") return "blocked by branch rules or a missing review"
  if (!lead || lead.state !== "open") return "pull request is not open"
  return "not ready"
}

/** A pull request Muninn is driving to merge: armed locally by the user, merged
 * by Muninn's refresh cycle — never delegated to the forge's own auto-merge. */
export interface ArmedEntry {
  repo: RepoRef
  number: number
  method: "merge" | "squash" | "rebase"
}

/** Armed entries whose chain is mergeable right now. Providers without merge or
 * review state fall back to checks, so this drives identically on any forge. */
export const armedTargets = (
  entries: readonly ArmedEntry[],
  chains: readonly Chain[],
): { pull: PullEntity; chain: Chain; method: ArmedEntry["method"] }[] => {
  const out: { pull: PullEntity; chain: Chain; method: ArmedEntry["method"] }[] = []
  for (const entry of entries) {
    const chain = chains.find((candidate) =>
      candidate.prs.some(
        (pull) => pull.state === "open" && pull.number === entry.number && repoKey(pull.repo) === repoKey(entry.repo),
      ),
    )
    if (!chain || !mergeReady(chain)) continue
    const pull = chain.prs.find((candidate) => candidate.number === entry.number)
    if (pull) out.push({ pull, chain, method: entry.method })
  }
  return out
}

/**
 * Worst-state helper for pill tones: failing runs and conflicted/revoked work
 * outrank everything; blocked and in-flight work read as warning; a fully green
 * chain reads as success.
 */
export const chainTone = (chain: Chain): "success" | "warning" | "danger" | undefined => {
  if (chain.runs.some((run) => run.status === "failed")) return "danger"
  const lead = chain.prs[0]
  if (lead?.mergeState === "conflict" || lead?.reviewState === "changes_requested") return "danger"
  if (chain.runs.some((run) => run.status === "running" || run.status === "queued")) return "warning"
  if (lead?.state === "open" && (lead.mergeState === "blocked" || lead.mergeState === "pending")) return "warning"
  if (lead?.state === "open" && mergeReady(chain)) return "success"
  if (lead?.state === "merged") return "success"
  if (chain.prs.length === 0 && chain.runs.some((run) => run.status === "succeeded")) return "success"
  return undefined
}
