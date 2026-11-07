/**
 * The GitHub provider: resolves repositories from parsed remotes, then hydrates
 * references over the REST API. Implements `SourceProvider` — swapping providers
 * means writing another file like this one, nothing else.
 */

import type { Credential, Plugin } from "@opencode/plugin"
import type { Entity, IssueEntity, PullEntity, Ref, RepoRef, RunEntity } from "../model"
import type { Auth, MergeMethod, MergeSettings, SourceProvider } from "./types"

const API = "https://api.github.com"
/** How long a hydrated entity is served from cache, in milliseconds. Keeps polling cheap. */
const TTL_MS = 45_000

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
}

interface RunJson {
  id: number
  name: string
  display_title: string
  status: "queued" | "in_progress" | "completed"
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
}

interface JobsJson {
  jobs: readonly { name: string; status: string; conclusion: string | null }[]
}

interface RepoJson {
  allow_merge_commit: boolean
  allow_squash_merge: boolean
  allow_rebase_merge: boolean
  delete_branch_on_merge: boolean
}

const request = async <T>(path: string, auth: Auth): Promise<T | undefined> => {
  const token = await auth()
  const response = await fetch(`${API}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "opencode-quartermaster",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  })
  if (response.status === 404) return undefined
  if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")
    throw new Error("GitHub rate limit exceeded")
  if (!response.ok) throw new Error(`GitHub ${response.status} on ${path}`)
  return (await response.json()) as T
}

const epoch = (iso: string): number => Date.parse(iso)

/** `Fixes #1, closes #2 and resolves #3` — the closing-keywords GitHub itself honors. */
const CLOSING = /\b(?:close[sd]?|closing|fix(?:e[sd]|ing)?|resolve[sd]?|resolving)\s*:?\s+#(\d+)/gi

const closingIssues = (body: string | null): number[] => {
  if (!body) return []
  return [...body.matchAll(CLOSING)].map((match) => Number(match[1]))
}

const runStatus = (run: RunJson): RunEntity["status"] => {
  if (run.status === "queued") return "queued"
  if (run.status === "in_progress") return "running"
  if (run.conclusion === "success") return "succeeded"
  if (run.conclusion === "cancelled" || run.conclusion === "skipped") return "cancelled"
  return "failed"
}

const checkStatus = (job: { status: string; conclusion: string | null }): RunEntity["status"] => {
  if (job.status === "queued") return "queued"
  if (job.status === "in_progress") return "running"
  if (job.conclusion === "success") return "succeeded"
  if (job.conclusion === "cancelled" || job.conclusion === "skipped") return "cancelled"
  return "failed"
}

const mergeMethods = (repo: RepoJson): MergeSettings => {
  const methods: MergeMethod[] = []
  if (repo.allow_merge_commit) methods.push("merge")
  if (repo.allow_squash_merge) methods.push("squash")
  if (repo.allow_rebase_merge) methods.push("rebase")
  const fallback: MergeMethod = methods.includes("squash") ? "squash" : (methods[0] ?? "merge")
  return { methods, default: fallback, deleteBranchByDefault: repo.delete_branch_on_merge }
}

// ── Hydration ───────────────────────────────────────────────────────────────

const cache = new Map<string, { at: number; entity?: Entity }>()

const cached = async (key: string, load: () => Promise<Entity | undefined>): Promise<Entity | undefined> => {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.entity
  const entity = await load()
  cache.set(key, { at: Date.now(), entity })
  return entity
}

const hydrateOne = async (ref: Ref & { repo: RepoRef }, auth: Auth): Promise<Entity | undefined> => {
  const base = `/repos/${ref.repo.owner}/${ref.repo.repo}`
  if (ref.kind === "run") return hydrateRun(ref.repo, ref.number, auth)

  // The issues API serves both; a bare `#123` learns its kind from the payload.
  const issue = await request<IssueJson>(`${base}/issues/${ref.number}`, auth)
  if (!issue) return undefined
  if (ref.kind !== "issue" && issue.pull_request) return hydratePull(ref.repo, ref.number, auth)

  const entity: IssueEntity = {
    kind: "issue",
    repo: ref.repo,
    number: issue.number,
    title: issue.title,
    state: issue.state,
    url: issue.html_url,
    updatedAt: epoch(issue.updated_at),
  }
  return entity
}

const hydratePull = async (repo: RepoRef, number: number, auth: Auth): Promise<PullEntity | undefined> => {
  const pull = await request<PullJson>(`/repos/${repo.owner}/${repo.repo}/pulls/${number}`, auth)
  if (!pull) return undefined
  return {
    kind: "pr",
    repo,
    number: pull.number,
    title: pull.title,
    state: pull.merged_at ? "merged" : pull.draft ? "draft" : pull.state,
    headBranch: pull.head.ref,
    baseBranch: pull.base.ref,
    closes: closingIssues(pull.body),
    headSha: pull.head.sha,
    url: pull.html_url,
    updatedAt: epoch(pull.updated_at),
  }
}

const hydrateRun = async (repo: RepoRef, id: number, auth: Auth): Promise<RunEntity | undefined> => {
  const base = `/repos/${repo.owner}/${repo.repo}/actions/runs`
  const run = await request<RunJson>(`${base}/${id}`, auth)
  if (!run) return undefined

  const jobs = await request<JobsJson>(`${base}/${id}/jobs?per_page=20`, auth)
  const checks = (jobs?.jobs ?? []).slice(0, 12).map((job) => ({ name: job.name, status: checkStatus(job) }))

  return {
    kind: "run",
    repo,
    id: run.id,
    name: run.name || run.display_title,
    headBranch: run.head_branch,
    headSha: run.head_sha,
    status: runStatus(run),
    checks,
    url: run.html_url,
    updatedAt: epoch(run.updated_at),
  }
}

/** token from an integration connection, or the environment as fallback. */
const resolveToken = async (ctx: Plugin.Context): Promise<string | undefined> => {
  const fromEnv = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (fromEnv) return fromEnv

  const connection = await ctx.integration.connection.active("github").catch(() => undefined)
  if (!connection) return undefined
  const credential = await ctx.integration.connection.resolve(connection).catch(() => undefined)

  return tokenFrom(credential)
}

const tokenFrom = (credential: Credential.Value | undefined): string | undefined => {
  if (!credential) return undefined
  return credential.type === "oauth" ? credential.access : credential.type === "key" ? credential.key : undefined
}

// ── The provider ────────────────────────────────────────────────────────────

export const github: SourceProvider = {
  id: "github",
  hosts: ["github.com"],

  auth: (ctx) => resolveToken(ctx as Plugin.Context),

  mergeSettings: async (repo, auth) => {
    const json = await request<RepoJson>(`/repos/${repo.owner}/${repo.repo}`, auth)
    return json ? mergeMethods(json) : undefined
  },

  hydrate: async (refs, _sessionRepo, auth) => {
    const unique = new Map<string, Ref & { repo: RepoRef }>()
    for (const ref of refs) unique.set(`${ref.repo.owner}/${ref.repo.repo}#${ref.number}`, ref)

    const entities = await Promise.all(
      [...unique.values()].map((ref) =>
        cached(`${ref.repo.owner}/${ref.repo.repo}#${ref.kind ?? "any"}${ref.number}`, () => hydrateOne(ref, auth)),
      ),
    )
    return entities.filter((entity): entity is Entity => entity !== undefined)
  },

  branchRuns: async (repo, branch, auth) => {
    const runs = await request<{ workflow_runs: readonly RunJson[] }>(
      `/repos/${repo.owner}/${repo.repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=8`,
      auth,
    )
    return (runs?.workflow_runs ?? []).map((run) => ({
      kind: "run" as const,
      repo,
      id: run.id,
      name: run.name || run.display_title,
      headBranch: run.head_branch,
      headSha: run.head_sha,
      status: runStatus(run),
      checks: [],
      url: run.html_url,
      updatedAt: epoch(run.updated_at),
    }))
  },
}
