/**
 * Muninn's server part. Runs inside the user's OpenCode server: it resolves
 * the session directory's forge repository, hydrates extracted references over the
 * provider APIs, and serves all of it to desktop windows through the RPC contract.
 * Providers register here; dispatch is by claimed host.
 */

import { Credential, Plugin } from "@opencode/plugin"
import { github } from "./providers/github"
import type { Ref, RepoRef } from "./model"
import { jsonReady } from "./model"
import type { SourceProvider } from "./providers/types"
import { parseRemoteUrl, readRemote } from "./remote"
import { Muninn } from "./rpc"
import { fastForwardDecision, selectCanonicalRemote, selectDirectRemote } from "./local-cleanup"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { promisify } from "node:util"
import { coordinateMerge } from "./merge-coordinator"

const exec = promisify(execFile)
const safeBranch = (branch: string): boolean => Boolean(branch) && !branch.startsWith("-") && !branch.includes("..")
const checkLocalWorktree = async (directory: string, branch: string, expectedHeadSha: string) => {
  if (!safeBranch(branch)) return { eligible: false, message: "local branch name is not safe to remove" }
  try {
    const current = (await exec("git", ["-C", directory, "branch", "--show-current"], { timeout: 5_000 })).stdout.trim()
    if (current !== branch) return { eligible: false, message: "local worktree is not on the PR branch; left it intact" }
    const head = (await exec("git", ["-C", directory, "rev-parse", `refs/heads/${branch}`], { timeout: 5_000 })).stdout.trim()
    if (head !== expectedHeadSha) return { eligible: false, message: "local branch differs from the merged PR head; left it intact" }
    const status = (await exec("git", ["-C", directory, "status", "--porcelain", "--untracked-files=all"], { timeout: 5_000 })).stdout
    if (status.trim()) return { eligible: false, message: "local worktree has changes; left it intact" }
    return { eligible: true }
  } catch (error) {
    return { eligible: false, message: error instanceof Error ? error.message : String(error) }
  }
}
const deleteLocalBranch = async (directory: string, branch: string, expectedHeadSha: string) => {
  if (!safeBranch(branch))
    return { deleted: false, message: "local branch name is not safe to delete" }
  try {
    const head = (await exec("git", ["-C", directory, "rev-parse", `refs/heads/${branch}`], { timeout: 5_000 })).stdout.trim()
    if (head !== expectedHeadSha)
      return { deleted: false, message: "local branch has commits newer or different from the merged PR" }
    const trees = (await exec("git", ["-C", directory, "worktree", "list", "--porcelain"], { timeout: 5_000 })).stdout
    if (trees.split("\n").some((line) => line === `branch refs/heads/${branch}`))
      return { deleted: false, message: "local branch is still checked out in another worktree" }
    await exec("git", ["-C", directory, "branch", "-d", "--", branch], { timeout: 5_000 })
    return { deleted: true }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      deleted: false,
      message: detail.toLowerCase().includes("not fully merged")
        ? "local branch is not merged into the local base; kept it to preserve history"
        : detail,
    }
  }
}
const fastForwardBase = async (
  directory: string,
  expectedRepo: RepoRef,
  branch: string,
  canonicalize?: (repo: RepoRef) => Promise<RepoRef | undefined>,
) => {
  if (!safeBranch(branch)) return { fastForwarded: false, message: "base branch name is invalid" }
  const fetchedRef = `refs/muninn/fast-forward/${process.pid}-${randomUUID()}`
  try {
    const remotes = (await exec("git", ["-C", directory, "remote"], { timeout: 5_000 })).stdout.trim().split(/\s+/).filter(Boolean)
    const candidates = await Promise.all(
      remotes.map(async (name) => {
        try {
          const url = (await exec("git", ["-C", directory, "remote", "get-url", name], { timeout: 5_000 })).stdout.trim()
          return { name, remote: parseRemoteUrl(url) }
        } catch {
          return { name, remote: undefined }
        }
      }),
    )
    const direct = selectDirectRemote(candidates, expectedRepo)
    let matchingRemote = direct
    if (!matchingRemote && canonicalize) {
      const canonicalByName = new Map<string, RepoRef | undefined>()
      for (const candidate of candidates) {
        if (candidate.remote === undefined) continue
        if (candidate.remote.host.toLowerCase() !== expectedRepo.host.toLowerCase()) continue
        try {
          canonicalByName.set(candidate.name, await canonicalize(candidate.remote))
        } catch {
          canonicalByName.set(candidate.name, undefined)
        }
      }
      matchingRemote = selectCanonicalRemote(candidates, expectedRepo, canonicalByName)
    }
    if (!matchingRemote) return { fastForwarded: false, message: "no configured remote matches the PR base repository" }
    await exec("git", ["-C", directory, "check-ref-format", "--branch", branch], { timeout: 5_000 })
    const currentBranch = (await exec("git", ["-C", directory, "branch", "--show-current"], { timeout: 5_000 })).stdout.trim()
    if (currentBranch !== branch) return { fastForwarded: false, message: `local checkout is not on ${branch}` }
    const status = (await exec("git", ["-C", directory, "status", "--porcelain", "--untracked-files=all"], { timeout: 5_000 })).stdout
    if (status.trim()) return { fastForwarded: false, message: "local base checkout has changes" }
    await exec("git", ["-C", directory, "fetch", "--no-tags", matchingRemote, `refs/heads/${branch}:${fetchedRef}`], { timeout: 30_000 })
    const target = (await exec("git", ["-C", directory, "rev-parse", `${fetchedRef}^{commit}`], { timeout: 5_000 })).stdout.trim()
    const before = (await exec("git", ["-C", directory, "rev-parse", "HEAD"], { timeout: 5_000 })).stdout.trim()
    const counts = (await exec("git", ["-C", directory, "rev-list", "--left-right", "--count", `${before}...${target}`], { timeout: 5_000 }))
      .stdout.trim().split(/\s+/).map(Number)
    if (counts.length !== 2 || counts.some((count) => !Number.isInteger(count)))
      return { fastForwarded: false, message: "could not compare local and forge base history" }
    const decision = fastForwardDecision({
      enabled: true,
      merged: true,
      onBaseBranch: currentBranch === branch,
      clean: !status.trim(),
      localOnly: counts[0]!,
      remoteOnly: counts[1]!,
    })
    if (!decision.advance) return { fastForwarded: false, message: decision.message }

    const recheckBranch = (await exec("git", ["-C", directory, "branch", "--show-current"], { timeout: 5_000 })).stdout.trim()
    const recheckStatus = (await exec("git", ["-C", directory, "status", "--porcelain", "--untracked-files=all"], { timeout: 5_000 })).stdout
    const recheckHead = (await exec("git", ["-C", directory, "rev-parse", "HEAD"], { timeout: 5_000 })).stdout.trim()
    if (recheckBranch !== branch || recheckStatus.trim() || recheckHead !== before)
      return { fastForwarded: false, message: "local base changed during fetch; left it unchanged" }
    await exec("git", ["-C", directory, "merge", "--ff-only", target], { timeout: 10_000 })
    return { fastForwarded: true }
  } catch (error) {
    return { fastForwarded: false, message: error instanceof Error ? error.message : String(error) }
  } finally {
    await exec("git", ["-C", directory, "update-ref", "-d", fetchedRef], { timeout: 5_000 }).catch(() => undefined)
  }
}
/** The plugin directory on disk (…/src), for stamping the server build. */
const pluginRoot = new URL("..", import.meta.url).pathname

let serverSha: string | undefined
const serverBuild = async (): Promise<string> => {
  if (serverSha) return serverSha
  try {
    serverSha = (await exec("git", ["-C", pluginRoot, "rev-parse", "--short", "HEAD"], { timeout: 5_000 })).stdout.trim()
  } catch {
    serverSha = "unknown"
  }
  return serverSha
}

/** Every source provider Muninn ships. GitLab and friends join this array. */
const sources: readonly SourceProvider[] = [github]

const sourceFor = (host: string | undefined): SourceProvider | undefined =>
  sources.find((source) => host !== undefined && source.hosts.includes(host))

export default Plugin.define({
  id: "muninn",
  async setup(ctx) {
    await ctx.rpc.register(Muninn, {
      repo: async (input) => {
        const remote = await readRemote(input.directory)
        if (!remote) return { provider: null, repo: null, authenticated: false, headSha: null, merge: null }

        const source = sourceFor(remote.host)
        if (!source) return { provider: null, repo: remote, authenticated: false, headSha: null, merge: null }

        const auth = () => source.auth(ctx)
        const authenticated = (await auth()) !== undefined
        const [merge, canonical, headSha] = await Promise.all([
          source.mergeSettings(remote, auth).catch(() => undefined),
          source.canonicalRepo?.(remote, auth).catch(() => undefined),
          exec("git", ["-C", input.directory, "rev-parse", "HEAD"], { timeout: 5_000 })
            .then((result) => result.stdout.trim() || null)
            .catch(() => null),
        ])
        return { provider: source.id, repo: canonical ?? remote, authenticated, headSha, merge: merge ?? null }
      },

      hydrate: async (input) => {
        const sessionRepo = await readRemote(input.directory)
        const sessionSource = sourceFor(sessionRepo?.host)

        // Group references by their claimed provider; session-repository references
        // inherit the session's provider.
        const groups = new Map<SourceProvider, (Ref & { repo: RepoRef })[]>()
        for (const ref of input.refs) {
          const repo = ref.repo ?? sessionRepo
          if (!repo) continue
          const source = sourceFor(repo.host) ?? sessionSource
          if (!source) continue
          const group = groups.get(source) ?? []
          group.push({ ...ref, repo })
          groups.set(source, group)
        }

        const results = await Promise.all(
          [...groups].map(([source, refs]) =>
            source
              .hydrate(refs, sessionRepo, () => source.auth(ctx))
              .catch(() => ({ entities: [], unresolved: refs as (Ref & { repo: RepoRef })[] })),
          ),
        )
        return {
          entities: results.flatMap((result) => result.entities).map(jsonReady),
          unresolved: results.flatMap((result) => result.unresolved).map(jsonReady),
        }
      },

      branchRuns: async (input) => {
        const repo = await readRemote(input.directory)
        const source = sourceFor(repo?.host)
        if (!repo || !source) return { runs: [], prs: [] }
        const result = await source.branchRuns(repo, input.branch, () => source.auth(ctx)).catch(() => ({ runs: [], prs: [] }))
        // Entity-carrying like hydrate: the strict-JSON boundary applies here too.
        return { runs: result.runs.map((run) => jsonReady(run)), prs: result.prs.map((pull) => jsonReady(pull)) }
      },
      debug: async () => ({ server: await serverBuild(), directory: pluginRoot }),
      merge: async (input) => {
        const repo = await readRemote(input.directory)
        if (!repo) return { merged: false, message: "no repository resolved for this directory" }
        const source = sourceFor(repo.host)
        if (!source) return { merged: false, message: `no provider for ${repo.host}` }
        const key = `${repo.host.toLowerCase()}/${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}#${input.number}`
        return coordinateMerge(key, input.expectedHeadSha, () =>
          source.merge(repo, input.number, input.method, input.expectedHeadSha, () => source.auth(ctx)),
        )
      },
      checkLocalWorktree: async (input) => checkLocalWorktree(input.directory, input.branch, input.expectedHeadSha),
      deleteLocalBranch: async (input) => deleteLocalBranch(input.directory, input.branch, input.expectedHeadSha),
      fastForwardBase: async (input) => {
        const source = sourceFor(input.repo.host)
        const auth = () => source!.auth(ctx)
        return fastForwardBase(input.directory, input.repo, input.baseBranch, async (repo) =>
          source?.canonicalRepo?.(repo, auth).catch(() => undefined),
        )
      },
      autoMerge: async (input) => {
        const repo = await readRemote(input.directory)
        if (!repo) return { armed: false, message: "no repository resolved for this directory" }
        const source = sourceFor(repo.host)
        if (!source) return { armed: false, message: `no provider for ${repo.host}` }
        return source.setAutoMerge(repo, input.number, input.enable, input.method, () => source.auth(ctx))
      },
    })
  },
})
