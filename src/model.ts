/**
 * The provider-agnostic model Quartermaster's UI renders. Providers (GitHub today,
 * GitLab or a tracker tomorrow) hydrate these; the GUI never sees provider specifics
 * beyond a `provider` mark and a repo slug.
 */

/** Repositories Quartermaster knows about, parsed from a git remote URL. */
export interface RepoRef {
  host: string
  owner: string
  repo: string
}

export type ProviderID = "github"

export type Kind = "issue" | "pr" | "run"

export type IssueState = "open" | "closed"

export type PullState = "open" | "draft" | "merged" | "closed"

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
}

export type Entity = IssueEntity | PullEntity | RunEntity

/**
 * One history card: an issue, the pull request that closes it, and that pull
 * request's CI runs — or any subset. `key` is stable across refreshes.
 */
export interface Chain {
  key: string
  issue?: IssueEntity
  pr?: PullEntity
  /** Newest first. */
  runs: readonly RunEntity[]
  updatedAt: number
}

export const repoKey = (repo: RepoRef): string => `${repo.host}/${repo.owner}/${repo.repo}`

export const refKey = (ref: Ref): string => (ref.repo ? `${repoKey(ref.repo)}#${ref.kind ?? ""}${ref.number}` : `#${ref.kind ?? ""}${ref.number}`)

/** Worst-state helper for pill tones: a failing run outranks everything on its chain. */
export const chainTone = (chain: Chain): "success" | "warning" | "danger" | undefined => {
  if (chain.runs.some((run) => run.status === "failed")) return "danger"
  if (chain.runs.some((run) => run.status === "running" || run.status === "queued")) return "warning"
  if (chain.pr?.state === "merged") return "success"
  if (chain.pr === undefined && chain.runs.some((run) => run.status === "succeeded")) return "success"
  return undefined
}
