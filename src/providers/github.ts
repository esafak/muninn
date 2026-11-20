/**
 * The GitHub provider: resolves repositories from parsed remotes, then hydrates
 * references over the REST API. Implements `SourceProvider` — swapping providers
 * means writing another file like this one, nothing else.
 */

import type { Credential, Plugin } from "@opencode/plugin"
import type { AutoMergeMethod, Entity, IssueEntity, MergeState, PullEntity, Ref, RepoRef, ReviewState, RunEntity } from "../model"
import type { Auth, Hydration, MergeMethod, MergeSettings, SourceProvider } from "./types"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { promisify } from "node:util"

const exec = promisify(execFile)

const API = "https://api.github.com"

/** A fixed auth function built from an already-resolved token. Each top-level
 * provider method resolves `auth()` once and threads this down, so the many
 * REST/GraphQL reads in one operation never re-resolve the credential. */
export const tokenAuth = (token: string | undefined): Auth => async () => token

// ── REST ────────────────────────────────────────────────────────────────────

interface IssueJson {
  number: number
  title: string
  state: "open" | "closed"
  body: string | null
  html_url: string
  updated_at: string
  pull_request?: unknown
}

interface PullJson {
  node_id: string
  number: number
  title: string
  state: "open" | "closed"
  draft: boolean
  merged_at: string | null
  body: string | null
  html_url: string
  updated_at: string
  head: { sha: string; ref: string }
  base: { ref: string }
  mergeable?: boolean | null
  mergeable_state?: "clean" | "blocked" | "unstable" | "dirty" | "draft" | "has_hooks" | "unknown" | string | null
  auto_merge: { merge_method: "merge" | "squash" | "rebase" } | null
}

interface ReviewJson {
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING"
  user: { login: string } | null
  submitted_at: string | null
}

interface ReviewThreadJson {
  isResolved: boolean
  isOutdated: boolean
}

interface ReviewThreadsJson {
  node: { reviewThreads: { nodes: ReviewThreadJson[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } | null
}

/** Threads that still need attention: unresolved and not outdated. Outdated
 * threads are anchored to a superseded diff, so they never gate a current head. */
export const unresolvedThreadCount = (threads: readonly ReviewThreadJson[]): number =>
  threads.filter((thread) => !thread.isResolved && !thread.isOutdated).length

interface RunJson {
  id: number
  workflow_id?: number | null
  name: string
  display_title: string
  // GitHub also returns "pending" (and "waiting") for runs that have not
  // started yet — keep this open so unknown non-completed states warn.
  status: string
  conclusion:
    | "success"
    | "failure"
    | "cancelled"
    | "skipped"
    | "timed_out"
    | "action_required"
    | "startup_failure"
    | null
  head_branch: string
  head_sha: string
  html_url: string
  updated_at: string
  pull_requests?: readonly { number: number }[]
}

interface JobsJson {
  jobs: readonly { name: string; status: string; conclusion: string | null }[]
}

interface CommitStatusJson {
  id: number
  context: string
  state: string
  updated_at: string
}

interface CheckRunJson {
  id: number
  name: string
  // Same forward-compat as runs: only "completed" is terminal for tone.
  status: string
  conclusion: string | null
  app?: { id: number } | null
}

interface RepoJson {
  full_name?: string
  allow_merge_commit: boolean
  allow_squash_merge: boolean
  allow_rebase_merge: boolean
  delete_branch_on_merge: boolean
}

export const mergeResponse = (body: unknown): { merged: boolean; message?: string } => {
  if (!body || typeof body !== "object") return { merged: false, message: "GitHub returned an invalid merge response" }
  const result = body as { merged?: unknown; message?: unknown }
  if (result.merged === true) return { merged: true }
  return {
    merged: false,
    message: typeof result.message === "string" ? result.message : "GitHub did not confirm that the pull request merged",
  }
}

export const staleHeadConflict = (status: number, expectedHeadSha: string, currentHeadSha: string | undefined): boolean =>
  status === 409 && currentHeadSha !== undefined && currentHeadSha !== expectedHeadSha

/** A failed merge PUT that actually confirms an already-merged PR: a post-grace
 * retry reaching the forge after dedupe expiry. Only a truthy `merged_at`
 * counts — a closed-unmerged or open PR keeps the original failure. */
export const mergeAlreadyHandled = (status: number, latest: { merged_at: string | null } | undefined): boolean =>
  status === 405 && !!latest?.merged_at

const request = async <T>(path: string, auth: Auth): Promise<T | undefined> => {
  const token = await auth()
  const response = await fetch(`${API}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "muninn",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(20_000),
  })
  if (response.status === 404) return undefined
  if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")
    throw new Error("GitHub rate limit exceeded")
  if (!response.ok) throw new Error(`GitHub ${response.status} on ${path}`)
  return (await response.json()) as T
}

/** GraphQL call — the only way to arm or disarm a pull request's auto-merge. */
const graphql = async <T>(query: string, variables: Record<string, unknown>, auth: Auth): Promise<T> => {
  const token = await auth()
  const response = await fetch(`${API}/graphql`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "muninn",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`GitHub GraphQL ${response.status}`)
  const body = (await response.json()) as { data?: T; errors?: { message: string }[] }
  if (body.errors?.length) throw new Error(body.errors.map((error) => error.message).join("; "))
  return body.data as T
}

const REVIEW_THREADS_QUERY = `query($id: ID!, $after: String) {
  node(id: $id) {
    ... on PullRequest {
      reviewThreads(first: 100, after: $after) {
        nodes { isResolved isOutdated }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`
const REVIEW_THREAD_PAGES = 5

/** Unresolved, non-outdated review threads for a PR. GraphQL-only: REST has no
 * thread resolution state. Returns undefined when the fetch fails so the merge
 * gate can fail closed on unknown state (an empty result must not be inferred
 * from a transport error). Bounded pagination keeps one PR from dominating a
 * hydration cycle. */
const loadUnresolvedThreads = async (nodeId: string, auth: Auth): Promise<number | undefined> => {
  try {
    const threads: ReviewThreadJson[] = []
    let after: string | null = null
    for (let page = 0; page < REVIEW_THREAD_PAGES; page++) {
      const data: ReviewThreadsJson = await graphql<ReviewThreadsJson>(REVIEW_THREADS_QUERY, { id: nodeId, after }, auth)
      const connection = data.node?.reviewThreads
      if (!connection) return undefined
      threads.push(...connection.nodes)
      if (!connection.pageInfo.hasNextPage) return unresolvedThreadCount(threads)
      after = connection.pageInfo.endCursor
      // More pages but no cursor: the count is incomplete, not zero.
      if (!after) return undefined
    }
    // Page cap hit with more pages remaining: unknown, never a partial count.
    return undefined
  } catch {
    return undefined
  }
}

const epoch = (iso: string): number => Date.parse(iso)

/** `Fixes #1, closes #2 and resolves #3` — the closing-keywords GitHub itself honors. */
const CLOSING = /\b(?:close[sd]?|closing|fix(?:e[sd]|ing)?|resolve[sd]?|resolving)\s*:?\s+#(\d+)/gi

const closingIssues = (body: string | null): number[] => {
  if (!body) return []
  return [...body.matchAll(CLOSING)].map((match) => Number(match[1]))
}

const runStatus = (run: RunJson): RunEntity["status"] => {
  // Only "completed" is terminal: pending/waiting/queued/in_progress and any
  // future non-completed state mean still in flight (warning, never danger).
  if (run.status !== "completed") return run.status === "in_progress" ? "running" : "queued"
  if (run.conclusion === "success") return "succeeded"
  if (run.conclusion === "skipped") return "succeeded"
  if (run.conclusion === "cancelled") return "cancelled"
  return "failed"
}

export const checkStatus = (job: { status: string; conclusion: string | null }): RunEntity["status"] => {
  if (job.status !== "completed") return job.status === "in_progress" ? "running" : "queued"
  if (job.conclusion === "success") return "succeeded"
  if (job.conclusion === "skipped") return "succeeded"
  if (job.conclusion === "cancelled") return "cancelled"
  return "failed"
}

const statusContextStatus = (state: string): RunEntity["status"] => {
  if (state === "success") return "succeeded"
  if (state === "pending") return "running"
  return "failed"
}

const checkRunStatus = (check: CheckRunJson): RunEntity["status"] => {
  if (check.status !== "completed") return check.status === "in_progress" ? "running" : "queued"
  return ["success", "neutral", "skipped"].includes(check.conclusion ?? "") ? "succeeded" : "failed"
}

const statusPageHasMore = (count: number): boolean => count === 100

export const decodeStatusPage = <T>(response: unknown, field?: string): readonly T[] | undefined => {
  if (Array.isArray(response)) return response as T[]
  if (!field || !response || typeof response !== "object") return undefined
  const rows = (response as Record<string, unknown>)[field]
  return Array.isArray(rows) ? rows as T[] : undefined
}

export const collectStatusPages = async <T>(fetchPage: (page: number) => Promise<readonly T[] | undefined>): Promise<T[] | undefined> => {
  const all: T[] = []
  for (let page = 1; ; page++) {
    const rows = await fetchPage(page)
    if (!rows) return undefined
    all.push(...rows)
    if (!statusPageHasMore(rows.length)) return all
  }
}

/** Only a forge that reports the PR clean may supersede a queued duplicate.
 * `clean`/`has_hooks` means every required check passed, so a still-queued
 * duplicate cannot be a required check GitHub is waiting on. */
export const shouldPreferCompletedOverQueued = (mergeState: MergeState | null): boolean => mergeState === "ready"

/** Exported for tests: latest status per context/attempt, already scoped to one head SHA.
 * With `preferCompletedOverQueued` (only for a clean forge verdict), trailing
 * queued/pending attempts no longer erase the newest real verdict for the same
 * check on this exact commit. `in_progress` and failing results still win;
 * a bypassed success is named in `resolvedQueued`. Selection uses the full
 * per-key chronology so API response order cannot change the outcome. */
export const statusCheckSnapshot = (
  headSha: string,
  statuses: readonly CommitStatusJson[],
  checkRuns: readonly CheckRunJson[] = [],
  preferCompletedOverQueued = false,
): NonNullable<PullEntity["statusChecks"]> => {
  const resolvedQueued: string[] = []
  const latest = new Map<string, CommitStatusJson>()
  const byContext = new Map<string, CommitStatusJson[]>()
  for (const status of statuses) {
    const group = byContext.get(status.context) ?? []
    group.push(status)
    byContext.set(status.context, group)
  }
  for (const [context, group] of byContext) {
    const ordered = group.toSorted((a, b) =>
      Date.parse(a.updated_at) - Date.parse(b.updated_at) || a.id - b.id)
    const newest = ordered[ordered.length - 1]
    if (!newest) continue
    let selected = newest
    let skippedQueued = false
    if (preferCompletedOverQueued && selected.state === "pending") {
      let i = ordered.length - 1
      while (i >= 0) {
        const candidate = ordered[i]
        if (!candidate || candidate.state !== "pending") break
        skippedQueued = true
        i--
      }
      const predecessor = ordered[i]
      if (predecessor) selected = predecessor
    }
    latest.set(context, selected)
    if (skippedQueued && selected.state === "success") resolvedQueued.push(`status-context:${context}`)
  }
  const latestChecks = new Map<string, CheckRunJson>()
  const byKey = new Map<string, CheckRunJson[]>()
  for (const check of checkRuns) {
    const key = `${check.app?.id ?? "unknown"}:${check.name}`
    const group = byKey.get(key) ?? []
    group.push(check)
    byKey.set(key, group)
  }
  for (const [key, group] of byKey) {
    const ordered = group.toSorted((a, b) => a.id - b.id)
    const newest = ordered[ordered.length - 1]
    if (!newest) continue
    let selected = newest
    let skippedQueued = false
    if (preferCompletedOverQueued && selected.status === "queued") {
      let i = ordered.length - 1
      while (i >= 0) {
        const candidate = ordered[i]
        if (!candidate || candidate.status !== "queued") break
        skippedQueued = true
        i--
      }
      const predecessor = ordered[i]
      if (predecessor) selected = predecessor
    }
    latestChecks.set(key, selected)
    if (skippedQueued && selected.status === "completed" &&
      ["success", "neutral", "skipped"].includes(selected.conclusion ?? ""))
      resolvedQueued.push(`check-run:${key}`)
  }
  const snapshot: NonNullable<PullEntity["statusChecks"]> = {
    headSha,
    state: "available",
    contexts: [
      ...[...latest.values()].map((status) => ({ name: `status-context:${status.context}`, status: statusContextStatus(status.state) })),
      ...[...latestChecks.entries()].map(([key, check]) => ({ name: `check-run:${key}`, status: checkRunStatus(check) })),
    ],
  }
  if (resolvedQueued.length === 0) return snapshot
  console.warn("[muninn] superseded queued checks with completed results", { headSha, contexts: resolvedQueued })
  return { ...snapshot, resolvedQueued }
}

const unavailableStatusChecks = (headSha: string): NonNullable<PullEntity["statusChecks"]> => ({
  headSha,
  state: "unavailable",
  contexts: [],
})

export const combineStatusCheckResults = (
  headSha: string,
  statuses: readonly CommitStatusJson[] | undefined,
  checkRuns: readonly CheckRunJson[] | undefined,
  preferCompletedOverQueued = false,
): NonNullable<PullEntity["statusChecks"]> =>
  statuses && checkRuns
    ? statusCheckSnapshot(headSha, statuses, checkRuns, preferCompletedOverQueued)
    : unavailableStatusChecks(headSha)

const loadPages = async <T>(path: string, field: "statuses" | "check_runs", auth: Auth): Promise<T[] | undefined> => {
  try {
    return await collectStatusPages(async (page) => {
      const separator = path.includes("?") ? "&" : "?"
      const response = await request<unknown>(`${path}${separator}per_page=100&page=${page}`, auth)
      return decodeStatusPage<T>(response, field === "statuses" ? undefined : field)
    })
  } catch {
    return undefined
  }
}

/** Whether this PR state can be merged and therefore needs current checks. */
export const shouldLoadStatusChecks = (pull: Pick<PullEntity, "state">): boolean => pull.state === "open"

/** Keep detail-endpoint evidence when branch discovery also found this PR. */
export const branchPullSnapshot = (
  listed: PullEntity,
  detailed: PullEntity | undefined,
  fallbackChecks: PullEntity["statusChecks"],
): PullEntity => detailed ?? (!fallbackChecks ? listed : {
  ...listed,
  // A branch-list row carries no review history. Without this marker a green
  // checks snapshot alone could authorize an armed merge with changes
  // requested by a reviewer we never loaded.
  reviewsIncomplete: true,
  statusChecks: fallbackChecks,
})

/** Opaque, auth-scoped status cache identity. Never stores or logs the raw token. */
export const statusCheckCacheKey = (repo: RepoRef, headSha: string, token: string | undefined): string => {
  const credential = token ? createHash("sha256").update(token).digest("hex") : "anonymous"
  return JSON.stringify([repo.host, repo.owner, repo.repo, headSha, credential])
}

/** Status identity for one immutable head. The queued-supersession preference
 * changes only how the raw results are combined, never which results are
 * fetched, so it is deliberately absent from the key. */
export const statusSnapshotCacheKey = statusCheckCacheKey

/** The two status endpoints, cached before client-side combination. */
interface StatusCheckRaw {
  statuses: readonly CommitStatusJson[] | undefined
  checkRuns: readonly CheckRunJson[] | undefined
}

/** Auth-scoped identity for the branch-runs fan-out, so one window's poll
 * collapses into the shared in-flight result for every other window. */
export const branchRunsCacheKey = (repo: RepoRef, branch: string, token: string | undefined): string => {
  const credential = token ? createHash("sha256").update(token).digest("hex") : "anonymous"
  return JSON.stringify([repo.host, repositoryCacheKey(repo), branch, credential])
}

export const cachedPromise = <T>(
  cache: Map<string, { at: number; promise: Promise<T> }>,
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
  now = Date.now(),
): Promise<T> => {
  const hit = cache.get(key)
  if (hit && now - hit.at < ttlMs) return hit.promise
  const promise = load()
  cache.set(key, { at: now, promise })
  return promise
}

/** Fetch both complete API surfaces; a partial response must stay distinguishable
 * from an empty one so the caller fails closed on unknown check state. */
const fetchStatusChecks = async (
  repo: RepoRef,
  headSha: string,
  token: string | undefined,
): Promise<StatusCheckRaw> => {
  const base = `/repos/${repo.owner}/${repo.repo}/commits/${encodeURIComponent(headSha)}`
  const auth: Auth = async () => token
  const [statuses, checkRuns] = await Promise.all([
    loadPages<CommitStatusJson>(`${base}/statuses`, "statuses", auth),
    loadPages<CheckRunJson>(`${base}/check-runs?filter=latest`, "check_runs", auth),
  ])
  return { statuses, checkRuns }
}

const loadStatusChecks = async (
  repo: RepoRef,
  headSha: string,
  auth: Auth,
  preferCompletedOverQueued = false,
): Promise<NonNullable<PullEntity["statusChecks"]>> => {
  let token: string | undefined
  try {
    token = await auth()
  } catch {
    return unavailableStatusChecks(headSha)
  }
  const key = statusSnapshotCacheKey(repo, headSha, token)
  const raw = cachedPromise(statusCheckCache, key, STATUS_TTL_MS, () =>
    fetchStatusChecks(repo, headSha, token))
  if (statusCheckCache.size > STATUS_CACHE_MAX_ENTRIES) {
    const oldest = statusCheckCache.keys().next().value
    if (oldest) statusCheckCache.delete(oldest)
  }
  const { statuses, checkRuns } = await raw
  return combineStatusCheckResults(headSha, statuses, checkRuns, preferCompletedOverQueued)
}

const mergeMethods = (repo: RepoJson): MergeSettings => {
  const methods: MergeMethod[] = []
  if (repo.allow_merge_commit) methods.push("merge")
  if (repo.allow_squash_merge) methods.push("squash")
  if (repo.allow_rebase_merge) methods.push("rebase")
  const fallback: MergeMethod = methods.includes("squash") ? "squash" : (methods[0] ?? "merge")
  return { methods, default: fallback, deleteBranchByDefault: repo.delete_branch_on_merge }
}

// ── Caching ─────────────────────────────────────────────────────────────────
// Three tiers, by how the underlying fact changes:
// - entity snapshots (statuses, titles) change fast — short TTL;
// - branch → open-PR membership changes when PRs merge or close — medium TTL;
// - run id → PR association and repo merge policy are effectively immutable —
//   cached for the life of the process, never re-queried once learned.

const ENTITY_TTL_MS = 45_000
// Merged and closed PRs change state slowly (or never). A 5-minute cache
// avoids spending pull+reviews calls on them every 45s poll while still
// catching a reopen. Explicit merge invalidation forces a fresh confirmation.
const TERMINAL_PR_TTL_MS = 5 * 60_000
const BRANCH_PR_TTL_MS = 5 * 60_000
const MERGE_TTL_MS = 10 * 60_000
// Fixed from request start: shorter than the 30s refresh interval and shared by
// concurrent hydration paths; stale data is never used as fallback after expiry.
const STATUS_TTL_MS = 20_000
const STATUS_CACHE_MAX_ENTRIES = 512
// branchRuns fans out (runs list + jobs per run + branch PRs). Every window
// polls it on each refresh, so without a shared short TTL N windows cost N×
// the REST calls and exhaust GitHub's hourly core quota.
const BRANCH_RUNS_TTL_MS = 20_000
const BRANCH_RUNS_CACHE_MAX_ENTRIES = 256

type BranchRunsResult = { runs: RunEntity[]; prs: PullEntity[] }

const cache = new Map<string, { at: number; entity?: Entity }>()
const statusCheckCache = new Map<string, { at: number; promise: Promise<StatusCheckRaw> }>()
const branchRunsCache = new Map<string, { at: number; promise: Promise<BranchRunsResult> }>()
const repositoryEpochs = new Map<string, number>()
const repositoryCacheKey = (repo: RepoRef): string => `${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}`
/** Shared identity for the single `/repos/{owner}/{repo}` payload read by both
 * merge-settings and canonical-repo resolution. */
export const repoMetadataCacheKey = (repo: RepoRef): string => repositoryCacheKey(repo)
const repositoryEpoch = (repo: RepoRef): number => repositoryEpochs.get(repositoryCacheKey(repo)) ?? 0
export const invalidatePullCacheEntries = <EntityEntry, BranchEntry>(
  entityCache: Map<string, EntityEntry>,
  branchCache: Map<string, BranchEntry>,
  repo: RepoRef,
  number: number,
): void => {
  const key = repositoryCacheKey(repo)
  entityCache.delete(`${key}#pr${number}`)
  entityCache.delete(`${key}#any${number}`)
  for (const branchKey of branchCache.keys())
    if (branchKey.toLowerCase().startsWith(`${key}:`)) branchCache.delete(branchKey)
}

const invalidatePullCaches = (repo: RepoRef, number: number): void => {
  const key = repositoryCacheKey(repo)
  repositoryEpochs.set(key, repositoryEpoch(repo) + 1)
  invalidatePullCacheEntries(cache, branchPullsCache, repo, number)
  // A merge changes the branch's PR list immediately; don't serve the pre-merge
  // fan-out for the rest of the short TTL.
  for (const cacheKey of branchRunsCache.keys())
    if (cacheKey.includes(`"${key}"`)) branchRunsCache.delete(cacheKey)
}

/** Cache lifetime for one hydrated entity: terminal PRs are stable facts. */
export const entityTtlFor = (entity: Entity | undefined): number =>
  entity?.kind === "pr" && (entity.state === "merged" || entity.state === "closed")
    ? TERMINAL_PR_TTL_MS
    : ENTITY_TTL_MS

const cached = async (
  key: string,
  repo: RepoRef,
  load: () => Promise<Entity | undefined>,
  retries = 2,
): Promise<Entity | undefined> => {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < entityTtlFor(hit.entity)) return hit.entity
  const epoch = repositoryEpoch(repo)
  const entity = await load()
  if (epoch !== repositoryEpoch(repo))
    return retries > 0 ? cached(key, repo, load, retries - 1) : undefined
  cache.set(key, { at: Date.now(), entity })
  return entity
}

/** run id → PR numbers. An association learned once is a fact forever. */
const runPullsCache = new Map<string, number[]>()

const branchPullsCache = new Map<string, { at: number; prs: PullEntity[] }>()

/** One `/repos/{owner}/{repo}` payload per repo per window, shared by merge
 * settings and canonical-repo resolution. The promise cache also collapses a
 * concurrent pair of callers into a single REST read. */
const repoMetadataCache = new Map<string, { at: number; promise: Promise<RepoJson | undefined> }>()

const loadRepoMetadata = (repo: RepoRef, auth: Auth): Promise<RepoJson | undefined> =>
  cachedPromise(repoMetadataCache, repoMetadataCacheKey(repo), MERGE_TTL_MS, async () => {
    const resolved = tokenAuth(await auth())
    return request<RepoJson>(`/repos/${repo.owner}/${repo.repo}`, resolved).catch(() => undefined)
  })

const hydrateOne = async (ref: Ref & { repo: RepoRef }, auth: Auth): Promise<Entity | undefined> => {
  const base = `/repos/${ref.repo.owner}/${ref.repo.repo}`
  if (ref.kind === "run") return hydrateRun(ref.repo, ref.number, auth)

  // A PR kind is a syntactic hint, not a verified type: "PR #123" can name an
  // issue. Probe only on a miss so real PRs skip the extra round trip.
  if (ref.kind === "pr") {
    const pull = await hydratePull(ref.repo, ref.number, auth)
    if (pull) return pull
    const issue = await request<IssueJson>(`${base}/issues/${ref.number}`, auth)
    return issue && !issue.pull_request ? toIssueEntity(ref.repo, issue) : undefined
  }
  // The issues API serves both; a bare `#123` learns its kind from the payload.
  const issue = await request<IssueJson>(`${base}/issues/${ref.number}`, auth)
  if (!issue) return undefined
  if (ref.kind !== "issue" && issue.pull_request) return hydratePull(ref.repo, ref.number, auth)
  return toIssueEntity(ref.repo, issue)
}

/** Repo coordinates as GitHub spells them after renames: `html_url` carries the
 * canonical `owner/repo`, while the request ref may use a stale alias that only
 * redirects. Falls back to the request repo when the URL is missing or malformed. */
export const repoFromUrl = (url: string | undefined, fallback: RepoRef): RepoRef => {
  try {
    const parsed = new URL(url ?? "")
    const segments = parsed.pathname.split("/").filter(Boolean)
    if (segments.length >= 2 && segments[0] && segments[1])
      return { host: parsed.hostname.toLowerCase(), owner: segments[0], repo: segments[1] }
  } catch {
    // Malformed URL: keep the request repo.
  }
  return fallback
}

/** `full_name` is `owner/repo` in GitHub's canonical casing after renames. */
export const repoFromFullName = (fullName: string | undefined, fallback: RepoRef): RepoRef => {
  const parts = (fullName ?? "").split("/")
  if (parts.length === 2 && parts[0] && parts[1]) return { host: fallback.host, owner: parts[0], repo: parts[1] }
  return fallback
}

/** Exported for tests: the entity contract this provider returns for an issue. */
export const toIssueEntity = (repo: RepoRef, issue: IssueJson): IssueEntity => ({
  kind: "issue",
  provider: "github",
  repo: repoFromUrl(issue.html_url, repo),
  number: issue.number,
  title: issue.title,
  state: issue.state,
  url: issue.html_url,
  updatedAt: epoch(issue.updated_at),
})

/** GitHub's `mergeable_state`, in Muninn's terms. `clean` (or `has_hooks`,
 * which still merges) is ready; `unstable`/`unknown` are checks still settling. */
const mergeState = (pull: PullJson): MergeState | null => {
  if (pull.state === "open" && !pull.draft) {
    if (pull.mergeable_state === "clean" || pull.mergeable_state === "has_hooks") return "ready"
    if (pull.mergeable_state === "blocked") return "blocked"
    if (pull.mergeable_state === "dirty") return "conflict"
    if (pull.mergeable_state) return "pending"
  }
  return null
}

const reviewState = (reviews: ReviewJson[] | undefined): ReviewState | null => {
  if (!reviews || reviews.length === 0) return null
  // Latest submitted review per user decides; a request for changes anywhere outranks approvals.
  const latest = new Map<string, ReviewJson["state"]>()
  for (const review of reviews)
    if (review.user && review.submitted_at && review.state !== "COMMENTED" && review.state !== "PENDING")
      latest.set(review.user.login, review.state)
  const states = [...latest.values()]
  if (states.includes("CHANGES_REQUESTED")) return "changes_requested"
  if (states.includes("APPROVED")) return "approved"
  return "pending"
}

/** Exported for tests: the entity contract this provider returns for a pull. */
export const toPullEntity = (repo: RepoRef, pull: PullJson): PullEntity => ({
  kind: "pr",
  provider: "github",
  repo: repoFromUrl(pull.html_url, repo),
  number: pull.number,
  title: pull.title,
  state: pull.merged_at ? "merged" : pull.draft ? "draft" : pull.state,
  // Absent, not undefined: the response transport encodes strict JSON, and a
  // key whose value is undefined fails the whole hydrate response.
  ...(pull.merged_at ? { mergedAt: epoch(pull.merged_at) } : {}),
  headBranch: pull.head.ref,
  baseBranch: pull.base.ref,
  closes: closingIssues(pull.body),
  headSha: pull.head.sha,
  nodeId: pull.node_id,
  mergeState: mergeState(pull),
  autoMerge: pull.auto_merge?.merge_method ?? null,
  url: pull.html_url,
  reviewUrl: `${pull.html_url}/files`,
  updatedAt: epoch(pull.updated_at),
})

const REVIEW_PAGES = 5

interface ReviewHistory {
  reviews: ReviewJson[] | undefined
  /** False on truncation or any failed page — the history may be missing a
   * later dismissal or change request. Consumers must not treat it as a
   * decision, either for or against merging. */
  complete: boolean
}

/** Review history for one PR, up to a bounded page count. The latest submitted
 * review per user decides, so a truncated tail could hide a later dismissal or
 * change request. Keep whatever was fetched (a known block must survive) but
 * mark the result incomplete so no gate can rely on it as a full decision. */
const loadReviews = async (repo: RepoRef, number: number, auth: Auth): Promise<ReviewHistory> => {
  const all: ReviewJson[] = []
  try {
    for (let page = 1; page <= REVIEW_PAGES; page++) {
      const rows = await request<ReviewJson[]>(
        `/repos/${repo.owner}/${repo.repo}/pulls/${number}/reviews?per_page=100&page=${page}`,
        auth,
      )
      if (!rows) break
      all.push(...rows)
      if (rows.length < 100) return { reviews: all, complete: true }
    }
  } catch {
    // Fall through with whatever was read; incomplete either way.
  }
  return { reviews: all.length > 0 ? all : undefined, complete: false }
}

const hydratePull = async (repo: RepoRef, number: number, auth: Auth): Promise<PullEntity | undefined> => {
  const pull = await request<PullJson>(`/repos/${repo.owner}/${repo.repo}/pulls/${number}`, auth)
  if (!pull) return undefined
  const entity = toPullEntity(repo, pull)
  // Reviews and commit statuses are extra reads per PR; a failing detail read
  // must not lose the PR itself, or one flaky endpoint hides the pill.
  const [reviewHistory, statusChecks, unresolvedThreads] = await Promise.all([
    loadReviews(repo, number, auth),
    shouldLoadStatusChecks(entity)
      ? loadStatusChecks(repo, pull.head.sha, auth, shouldPreferCompletedOverQueued(entity.mergeState ?? null))
      : Promise.resolve(undefined),
    entity.state === "open" && entity.nodeId ? loadUnresolvedThreads(entity.nodeId, auth) : Promise.resolve(undefined),
  ])
  return {
    ...entity,
    reviewState: reviewHistory.reviews ? reviewState(reviewHistory.reviews) : null,
    ...(reviewHistory.complete ? {} : { reviewsIncomplete: true }),
    ...(statusChecks ? { statusChecks } : {}),
    ...(unresolvedThreads !== undefined ? { unresolvedThreads } : {}),
  }
}

/**
 * Open PRs whose head matches `branch` — the association for push-triggered runs,
 * whose pull_requests array comes back empty.
 */
const pullsForBranch = async (repo: RepoRef, branch: string, auth: Auth, retries = 2): Promise<PullEntity[]> => {
  const key = `${repositoryCacheKey(repo)}:${branch}`
  const epoch = repositoryEpoch(repo)
  const hit = branchPullsCache.get(key)
  if (hit && Date.now() - hit.at < BRANCH_PR_TTL_MS) return hit.prs

  // Merged PRs must match too: a run's association outlives the merge.
  const pulls = await request<PullJson[]>(
    `/repos/${repo.owner}/${repo.repo}/pulls?head=${encodeURIComponent(`${repo.owner}:${branch}`)}&state=all&per_page=5`,
    auth,
  )
  if (epoch !== repositoryEpoch(repo))
    return retries > 0 ? pullsForBranch(repo, branch, auth, retries - 1) : []
  const prs = (pulls ?? []).map((pull) => toPullEntity(repo, pull))
  branchPullsCache.set(key, { at: Date.now(), prs })
  return prs
}

/** Exported for tests: pure when `withChecks` is false — the jobs request is skipped. */
export const runEntity = async (repo: RepoRef, run: RunJson, auth: Auth, withChecks: boolean): Promise<RunEntity> => {
  let checks: RunEntity["checks"] = []
  if (withChecks) {
    // Jobs are detail, not identity: a failing jobs read must not lose the run.
    const jobs = await request<JobsJson>(
      `/repos/${repo.owner}/${repo.repo}/actions/runs/${run.id}/jobs?per_page=20`,
      auth,
    ).catch(() => undefined)
    checks = (jobs?.jobs ?? []).slice(0, 12).map((job) => ({ name: job.name, status: checkStatus(job) }))
  }
  return {
    kind: "run",
    provider: "github",
    repo: repoFromUrl(run.html_url, repo),
    id: run.id,
    name: run.name || run.display_title,
    headBranch: run.head_branch,
    headSha: run.head_sha,
    ...(run.workflow_id == null ? {} : { series: { key: String(run.workflow_id), sequence: run.id } }),
    status: runStatus(run),
    checks,
    pullRequests: (run.pull_requests ?? []).map((pr) => pr.number),
    url: run.html_url,
    updatedAt: epoch(run.updated_at),
  }
}

/** A directly hydrated run is cached under the ref's kind (`#run<id>`), or
 * under `#any<id>` when the transcript ref was bare. Both mean "already read". */
export const directRunKeys = (repoKey: string, id: number): readonly string[] => [
  `${repoKey}#run${id}`,
  `${repoKey}#any${id}`,
]

/** Branch-listed runs whose direct counterpart was already hydrated get their
 * checks from that entity instead of paying for a fresh `/jobs` read. */
export const shouldFetchBranchJobs = (repoKey: string, id: number, cachedKeys: ReadonlySet<string>): boolean =>
  !directRunKeys(repoKey, id).some((key) => cachedKeys.has(key))

/** Take only `checks` from the cached entity. Jobs change under a stable run
 * id; identity, status, head and time must come from the fresh list payload. */
export const withCachedChecks = (fresh: RunEntity, cached: RunEntity | undefined): RunEntity =>
  cached ? { ...fresh, checks: cached.checks } : fresh

const hydrateRun = async (repo: RepoRef, id: number, auth: Auth): Promise<RunEntity | undefined> => {
  const run = await request<RunJson>(`/repos/${repo.owner}/${repo.repo}/actions/runs/${id}`, auth)
  if (!run) return undefined
  return runEntity(repo, run, auth, true)
}

/** token from an integration connection, or the environment as fallback. */
const resolveToken = async (ctx: Plugin.Context): Promise<string | undefined> => {
  const fromEnv = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (fromEnv) return fromEnv

  // The GitHub CLI is the most common already-authenticated credential: use it
  // when present, before falling back to integration connections.
  const fromGh = await ghAuthToken()
  if (fromGh) return fromGh

  // The integration API is newer than some app versions; treat absence as no
  // credential rather than letting a synchronous access error reject the caller.
  // Raced with a timeout: an integration promise that never settles in some app
  // contexts must not hang the RPC (this froze refresh at "no response logged").
  try {
    const connection = await race(ctx.integration.connection.active("github"), 5_000)
    if (!connection) return undefined
    const credential = await race(ctx.integration.connection.resolve(connection), 5_000)
    return tokenFrom(credential)
  } catch {
    return undefined
  }
}

/** Resolves with the promise's value, or undefined after `ms` without settling. */
const race = <T>(promise: Promise<T>, ms: number): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<T | undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** `gh auth token`, cached once resolved; failures share one lookup with a short cooldown. */
const GH_TOKEN_RETRY_MS = 10_000
let ghTokenCache: string | undefined = undefined
let ghTokenResolved = false
let ghTokenFailedAt = 0
let ghTokenPending: Promise<string | undefined> | undefined
const ghAuthToken = async (): Promise<string | undefined> => {
  // A success is sticky; a failure is not, so a transient startup failure (e.g.
  // keyring not ready) can recover. Concurrent callers share one in-flight
  // lookup instead of each spawning subprocesses, and failures back off briefly.
  if (ghTokenResolved) return ghTokenCache
  if (ghTokenPending) return ghTokenPending
  if (Date.now() - ghTokenFailedAt < GH_TOKEN_RETRY_MS) return undefined
  // The desktop server can run with a minimal PATH (GUI-launched): gh is often a
  // shell-version-manager shim (mise, asdf) that only a user shell resolves.
  const attempts = [
    () => exec("gh", ["auth", "token"], { timeout: 10_000 }),
    () => exec("/bin/zsh", ["-ic", "gh auth token"], { timeout: 10_000 }),
  ]
  ghTokenPending = (async () => {
    for (const run of attempts) {
      try {
        const { stdout } = await run()
        const token = stdout.trim()
        if (token) {
          ghTokenCache = token
          ghTokenResolved = true
          return token
        }
      } catch {
        // Try the next resolution strategy.
      }
    }
    ghTokenFailedAt = Date.now()
    return undefined
  })()
  try {
    return await ghTokenPending
  } finally {
    ghTokenPending = undefined
  }
}

const tokenFrom = (credential: Credential.Value | undefined): string | undefined => {
  if (!credential) return undefined
  return credential.type === "oauth" ? credential.access : credential.type === "key" ? credential.key : undefined
}

/** The uncached branch-runs fan-out. Called only through branchRunsCache, so
 * every window polling the same branch shares one set of REST calls. */
const loadBranchRuns = async (repo: RepoRef, branch: string, auth: Auth, retries = 2): Promise<BranchRunsResult> => {
  const epoch = repositoryEpoch(repo)
  // Runs and PRs are independent: a failing runs list must not lose the
  // branch PRs (the pill), and vice versa.
  const runs = await request<{ workflow_runs: readonly RunJson[] }>(
    `/repos/${repo.owner}/${repo.repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=8`,
    auth,
  ).catch(() => undefined)
  // A failed runs request (e.g. 404 on a private repo without access) is
  // swallowed by request() as undefined, which is otherwise
  // indistinguishable from a branch with no runs. Log the failure; an
  // empty but successful response is normal and must stay silent.
  if (runs === undefined) console.warn("[muninn] branchRuns: runs request failed", { owner: repo.owner, repo: repo.repo, branch })
  const runEntities = (
    await Promise.all(
      (runs?.workflow_runs ?? []).map((run) =>
        runEntity(repo, run, auth, true).catch(() => undefined),
      ),
    )
  ).filter((entity): entity is RunEntity => entity !== undefined)
  // Branch runs are push-triggered: their pull_requests array comes back empty,
  // so query the branch's open PRs and let the GUI associate by head SHA.
  const pulls = await pullsForBranch(repo, branch, auth).catch(() => [] as PullEntity[])
  const prs = await Promise.all(pulls.map(async (pull) => {
    if (!shouldLoadStatusChecks(pull)) return branchPullSnapshot(pull, undefined, undefined)
    // The pulls list endpoint is association-only and omits mergeability and
    // review details. Prefer the cached `/pulls/{number}` entity so this
    // branch-run result cannot overwrite richer hydration in the GUI.
    const detailed = await cached(
      `${repositoryCacheKey(repo)}#pr${pull.number}`,
      repo,
      () => hydratePull(repo, pull.number, auth),
    ).catch(() => undefined)
    const detailedPull = detailed?.kind === "pr" ? detailed : undefined
    const fallbackChecks = detailedPull ? undefined : await loadStatusChecks(repo, pull.headSha, auth)
    return branchPullSnapshot(pull, detailedPull, fallbackChecks)
  }))
  if (epoch !== repositoryEpoch(repo))
    return retries > 0 ? loadBranchRuns(repo, branch, auth, retries - 1) : { runs: [], prs: [] }
  return { runs: runEntities, prs }
}

// ── The provider ────────────────────────────────────────────────────────────

export const github: SourceProvider = {
  id: "github",
  hosts: ["github.com"],

  auth: (ctx) => resolveToken(ctx as Plugin.Context),

  mergeSettings: async (repo, auth) => {
    const json = await loadRepoMetadata(repo, auth)
    return json ? mergeMethods(json) : undefined
  },

  canonicalRepo: async (repo, auth) => {
    const json = await loadRepoMetadata(repo, auth)
    if (!json?.full_name) return undefined
    return repoFromFullName(json.full_name, repo)
  },

  hydrate: async (refs, _sessionRepo, auth) => {
    const resolved = tokenAuth(await auth())
    const unique = new Map<string, Ref & { repo: RepoRef }>()
    for (const ref of refs) unique.set(`${ref.repo.owner}/${ref.repo.repo}#${ref.number}`, ref)
    const epochs = new Map<string, number>()
    for (const ref of unique.values()) epochs.set(repositoryCacheKey(ref.repo), repositoryEpoch(ref.repo))
    let error: string | undefined

    const results = await Promise.all(
      [...unique.values()].map(async (ref) => {
        try {
          const entity = await cached(
            `${repositoryCacheKey(ref.repo)}#${ref.kind ?? "any"}${ref.number}`,
            ref.repo,
            () => hydrateOne(ref, resolved),
          )
          return { ref, entity }
        } catch (cause) {
          // One failing ref (transient 502, rate limit) must not wedge the
          // whole batch: it becomes unresolved while the rest still hydrate,
          // so a PR pill survives a bad run ref. Keep the first cause for the
          // diagnostic footer — a bad token otherwise looks like a bad ref.
          error ??= cause instanceof Error ? cause.message : String(cause)
          return { ref, entity: undefined }
        }
      }),
    )

    const entities: Entity[] = []
    const unresolved: (Ref & { repo: RepoRef })[] = []
    for (const result of results) {
      if (result.entity) entities.push(result.entity)
      else unresolved.push(result.ref)
    }

    // Runs belong to pull requests the session may never have mentioned. The
    // association is an immutable fact: pull_requests from the run payload, else
    // learned once from the head branch (push runs report it empty) and kept in
    // runPullsCache forever after.
    const related = new Map<string, Ref & { repo: RepoRef }>()
    for (const entity of entities) {
      if (entity.kind !== "run") continue
      const runKey = `${entity.repo.owner}/${entity.repo.repo}:${entity.id}`
      let numbers = entity.pullRequests.length > 0 ? entity.pullRequests : runPullsCache.get(runKey)
      if (!numbers) {
        const prs = await pullsForBranch(entity.repo, entity.headBranch, resolved).catch((cause: unknown) => {
          error ??= cause instanceof Error ? cause.message : String(cause)
          return []
        })
        numbers = prs.map((pr) => pr.number)
        runPullsCache.set(runKey, numbers)
      }
      for (const number of numbers) {
        const key = `${entity.repo.owner}/${entity.repo.repo}#${number}`
        if (![...unique.values()].some((ref) => ref.repo.owner === entity.repo.owner && ref.repo.repo === entity.repo.repo && ref.number === number))
          related.set(key, { kind: "pr", number, repo: entity.repo })
      }
    }
    const relatedEntities = await Promise.all(
      [...related.values()].map(async (ref) => {
        try {
          const entity = await cached(
            `${repositoryCacheKey(ref.repo)}#pr${ref.number}`,
            ref.repo,
            () => hydratePull(ref.repo, ref.number, resolved),
          )
          return { entity }
        } catch (cause) {
          error ??= cause instanceof Error ? cause.message : String(cause)
          return { entity: undefined }
        }
      }),
    )
    entities.push(...relatedEntities.filter((result) => result.entity !== undefined).map((result) => result.entity!))

    const staleRepos = new Set(
      [...epochs].filter(([key, epoch]) => (repositoryEpochs.get(key) ?? 0) !== epoch).map(([key]) => key),
    )
    if (staleRepos.size === 0) return { entities, unresolved, error }
    return {
      entities: entities.filter((entity) => !staleRepos.has(repositoryCacheKey(entity.repo))),
      unresolved: [
        ...unresolved,
        ...[...unique.values()].filter((ref) => staleRepos.has(repositoryCacheKey(ref.repo))),
      ],
      error,
    }
  },
  branchRuns: async (repo, branch, auth) => {
    let token: string | undefined
    try {
      token = await auth()
    } catch {
      return { runs: [], prs: [] }
    }
    if (branchRunsCache.size >= BRANCH_RUNS_CACHE_MAX_ENTRIES) {
      const oldest = branchRunsCache.keys().next().value
      if (oldest) branchRunsCache.delete(oldest)
    }
    return cachedPromise(
      branchRunsCache,
      branchRunsCacheKey(repo, branch, token),
      BRANCH_RUNS_TTL_MS,
      () => loadBranchRuns(repo, branch, tokenAuth(token)),
    )
  },

  merge: async (repo, number, method, expectedHeadSha, auth) => {
    const token = await auth()
    const resolved = tokenAuth(token)
    const headers = {
      accept: "application/vnd.github+json",
      "user-agent": "muninn",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    }
    const merge = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls/${number}/merge`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ sha: expectedHeadSha, merge_method: method }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!merge.ok) {
      const detail = await merge.json().catch(() => ({ message: merge.statusText }))
      const latest = merge.status === 409 || merge.status === 405
        ? await request<PullJson>(`/repos/${repo.owner}/${repo.repo}/pulls/${number}`, resolved).catch(() => undefined)
        : undefined
      const headChanged = staleHeadConflict(merge.status, expectedHeadSha, latest?.head.sha)
      if (headChanged && latest) invalidatePullCaches(repo, number)
      if (mergeAlreadyHandled(merge.status, latest)) {
        invalidatePullCaches(repo, number)
        return { merged: false, alreadyHandled: true }
      }
      return {
        merged: false,
        message: `GitHub ${merge.status}: ${(detail as { message?: string }).message ?? merge.statusText}`,
        ...(headChanged ? { headChanged: true } : {}),
      }
    }
    const outcome = mergeResponse(await merge.json().catch(() => undefined))
    if (!outcome.merged) return outcome
    invalidatePullCaches(repo, number)
    return { merged: true }
  },

  /** Arms or disarms auto-merge — merge when CI is green and required reviews pass.
   * GraphQL-only on GitHub's side; needs the PR's node id. */
  setAutoMerge: async (repo, number, enable, method, auth) => {
    const resolved = tokenAuth(await auth())
    const pull = await request<PullJson>(`/repos/${repo.owner}/${repo.repo}/pulls/${number}`, resolved)
    if (!pull?.node_id) return { armed: false, message: "pull request not found" }
    try {
      if (enable) {
        await graphql(
          "mutation($id: ID!, $method: PullRequestMergeMethod!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method }) { clientMutationId } }",
          { id: pull.node_id, method },
          resolved,
        )
      } else {
        await graphql(
          "mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }",
          { id: pull.node_id },
          resolved,
        )
      }
      return { armed: enable }
    } catch (error) {
      return { armed: false, message: error instanceof Error ? error.message : "auto-merge failed" }
    }
  },
}
