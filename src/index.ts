/**
 * Muninn's server part. Runs inside the user's OpenCode server: it resolves
 * the session directory's forge repository, hydrates extracted references over the
 * provider APIs, and serves all of it to desktop windows through the RPC contract.
 * Providers register here; dispatch is by claimed host.
 */

import { Credential, Plugin } from "@opencode/plugin"
import { github } from "./providers/github"
import type { Ref, RepoRef } from "./model"
import { jsonReady, refKey } from "./model"
import type { SourceProvider } from "./providers/types"
import { parseRemoteUrl, readRemote } from "./remote"
import { Muninn } from "./rpc"
import { fastForwardDecision, isCleanStatus, selectCanonicalRemote, selectDirectRemote, untrackedFilesArg } from "./local-cleanup"
import { candidateCacheKey, createCandidateCache } from "./candidates/cache"
import { DECISION_TIMEOUT_MS, KEEP_THRESHOLD } from "./candidates/constants"
import { defaultModelForProvider, decisionProviderLabel, isAuthoritativeProvider, knownModelsForProvider } from "./providers/decision-catalog"
import { buildServerJudgeRequest, buildVerdict, mapServerJudgeAnswers, matchRegistryModel, resolveModelStatus, toRegistryModels } from "./candidates/server-judge"
import { validateModelSyntax } from "./candidates/model-id"
import type { JudgeInput } from "./candidates/types"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { promisify } from "node:util"
import { coordinateMerge } from "./merge-coordinator"

const exec = promisify(execFile)
const safeBranch = (branch: string): boolean => Boolean(branch) && !branch.startsWith("-") && !branch.includes("..")
const checkLocalWorktree = async (directory: string, branch: string, expectedHeadSha: string, trackedOnly = false) => {
  if (!safeBranch(branch)) return { eligible: false, message: "local branch name is not safe to remove" }
  try {
    const current = (await exec("git", ["-C", directory, "branch", "--show-current"], { timeout: 5_000 })).stdout.trim()
    if (current !== branch) return { eligible: false, message: "local worktree is not on the PR branch; left it intact" }
    const head = (await exec("git", ["-C", directory, "rev-parse", `refs/heads/${branch}`], { timeout: 5_000 })).stdout.trim()
    if (head !== expectedHeadSha) return { eligible: false, message: "local branch differs from the merged PR head; left it intact" }
    const status = (await exec("git", ["-C", directory, "status", "--porcelain", untrackedFilesArg(trackedOnly)], { timeout: 5_000 })).stdout
    if (!isCleanStatus(status)) return { eligible: false, message: "local worktree has changes; left it intact" }
    return { eligible: true }
  } catch (error) {
    return { eligible: false, message: error instanceof Error ? error.message : String(error) }
  }
}
const deleteLocalBranch = async (directory: string, branch: string, expectedHeadSha: string, force = false) => {
  if (!safeBranch(branch))
    return { deleted: false, message: "local branch name is not safe to delete" }
  try {
    const head = (await exec("git", ["-C", directory, "rev-parse", `refs/heads/${branch}`], { timeout: 5_000 })).stdout.trim()
    if (head !== expectedHeadSha)
      return { deleted: false, message: "local branch has commits newer or different from the merged PR" }
    const trees = (await exec("git", ["-C", directory, "worktree", "list", "--porcelain"], { timeout: 5_000 })).stdout
    if (trees.split("\n").some((line) => line === `branch refs/heads/${branch}`))
      return { deleted: false, message: "local branch is still checked out in another worktree" }
    if (force) {
      // Atomic expected-SHA deletion: the lease rejects a tip that advanced
      // after validation, and the push refuses a checked-out branch. Plain
      // `git branch -D` and `update-ref -d` offer neither guarantee.
      await exec(
        "git",
        ["-C", directory, "push", `--force-with-lease=refs/heads/${branch}:${expectedHeadSha}`, directory, `:refs/heads/${branch}`],
        { timeout: 5_000 },
      )
    } else {
      await exec("git", ["-C", directory, "branch", "-d", "--", branch], { timeout: 5_000 })
    }
    return { deleted: true }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const lowered = detail.toLowerCase()
    return {
      deleted: false,
      message: lowered.includes("not fully merged")
        ? "local branch is not merged into the local base; kept it to preserve history"
        : lowered.includes("stale info")
          ? "local branch advanced during cleanup; left it intact"
          : detail,
    }
  }
}
/** Switch a canonical checkout to its base branch after a merge. The caller
 * verifies PR ownership and head identity; this re-checks tracked dirt at the
 * environment boundary so no staged/tracked work is carried across branches.
 * Untracked files intentionally ride along (same as fast-forward): `switch`
 * either preserves them or fails safely on overwrite, which we report intact. */
const switchToBase = async (directory: string, branch: string) => {
  if (!safeBranch(branch)) return { switched: false, message: "base branch name is invalid" }
  try {
    const current = (await exec("git", ["-C", directory, "branch", "--show-current"], { timeout: 5_000 })).stdout.trim()
    if (current === branch) return { switched: false, previous: current }
    const status = (await exec("git", ["-C", directory, "status", "--porcelain", untrackedFilesArg(true)], { timeout: 5_000 })).stdout
    if (!isCleanStatus(status)) return { switched: false, previous: current, message: "local checkout has changes; left it intact" }
    // Branch-only semantics: unlike `checkout`, `switch` never detaches HEAD
    // onto a same-named tag. Verify the landing spot regardless.
    await exec("git", ["-C", directory, "switch", branch], { timeout: 5_000 })
    const landed = (await exec("git", ["-C", directory, "branch", "--show-current"], { timeout: 5_000 })).stdout.trim()
    if (landed !== branch) return { switched: false, previous: current, message: `local checkout did not land on ${branch}; left it intact` }
    return { switched: true, previous: current }
  } catch (error) {
    return { switched: false, message: error instanceof Error ? error.message : String(error) }
  }
}
/** Tracked-only cleanliness for the worktree-flow canonical gate. Untracked
 * files never count; any command failure is fail-closed (clean false) so a
 * missing checkout cannot pass the gate. */
const checkClean = async (directory: string) => {
  try {
    const status = (await exec("git", ["-C", directory, "status", "--porcelain", untrackedFilesArg(true)], { timeout: 5_000 })).stdout
    if (!isCleanStatus(status)) return { clean: false, message: "canonical checkout has changes; worktree left intact" }
    return { clean: true }
  } catch (error) {
    return { clean: false, message: error instanceof Error ? error.message : String(error) }
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
    // Tracked dirt only: untracked files never block a fast-forward (`merge
    // --ff-only` below refuses safely on its own), so plan files and the like
    // must not veto the base update. Worktree removal keeps the strict check.
    const status = (await exec("git", ["-C", directory, "status", "--porcelain", "--untracked-files=no"], { timeout: 5_000 })).stdout
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
    const recheckStatus = (await exec("git", ["-C", directory, "status", "--porcelain", "--untracked-files=no"], { timeout: 5_000 })).stdout
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
    // Decision auth is the user's connected OpenCode account (ChatGPT/Codex
    // OAuth, OpenRouter key, Console/Go, Gemini API): the plugin holds no
    // keys and reads no key options or key env vars. Hard transition.
    const judgeCache = createCandidateCache()
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
      checkLocalWorktree: async (input) => checkLocalWorktree(input.directory, input.branch, input.expectedHeadSha, input.trackedOnly ?? false),
      deleteLocalBranch: async (input) => deleteLocalBranch(input.directory, input.branch, input.expectedHeadSha, input.force ?? false),
      checkoutBase: async (input) => switchToBase(input.directory, input.baseBranch),
      checkClean: async (input) => checkClean(input.directory),
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
      judge: async (input) => {
        const sessionRepo = await readRemote(input.directory).catch(() => undefined)
        const candidates: JudgeInput[] = input.candidates.map((c) => ({
          ref: { number: c.number, ...(c.kind ? { kind: c.kind } : {}), ...(c.repo ?? sessionRepo ? { repo: (c.repo ?? sessionRepo)! } : {}), tier: c.tier },
          snippet: c.snippet,
          ...(c.command ? { command: c.command } : {}),
          ...(c.title ? { title: c.title } : {}),
          ...(c.state ? { state: c.state } : {}),
        }))
        const fallback = (reason: string) => ({
          verdicts: candidates.map((c) => ({ key: refKey(c.ref), keep: true, reason })),
        })
        if (candidates.length === 0) return { verdicts: [] }
        const providerID = input.providerID.trim()
        const requested = (input.model ?? "").trim()
        const defaultId = requested || defaultModelForProvider(providerID)
        if (!defaultId) return fallback("no default for this provider: heuristic fallback")
        // Canonicalize against the registry when discovery succeeds; otherwise
        // judge the requested/default ID verbatim (fail-open).
        const discovered = await ctx.model.list().catch(() => undefined)
        const canonicalId =
          matchRegistryModel(toRegistryModels(discovered?.data ?? []), providerID, defaultId)?.id ?? defaultId
        // Cache scope is the full judge identity: provider + canonical model.
        // Titles/states ride inside the key (see cache.ts), so verdicts never
        // leak across providers, models, or evidence.
        const scope = `${providerID}:${canonicalId}`
        const cacheKeys = candidates.map((c) => candidateCacheKey(c, scope))
        const cachedHits = cacheKeys.map((k) => judgeCache.get(k))
        const pendingIndexes: number[] = []
        cachedHits.forEach((hit, i) => {
          if (!hit) pendingIndexes.push(i)
        })
        if (pendingIndexes.length === 0) {
          return {
            verdicts: candidates.map((c, i) => {
              const hit = cachedHits[i]!
              return { key: refKey(c.ref), keep: hit.keep, reason: hit.reason, confidence: hit.confidence }
            }),
          }
        }
        const pendingInputs = pendingIndexes.map((i) => candidates[i]!)
        const { input: reqInput, questions, names } = buildServerJudgeRequest(pendingInputs)
        // One request for all pending questions (parallel + isolated); the
        // server resolves the user's connected account. Failure, timeout,
        // invalid answers, or error answers fall back to keep-all without
        // caching a drop. No chunking: only exact, verified splittable
        // signals would split, and none are verified for this boundary.
        const byKey = new Map<string, { keep: boolean; reason: string; confidence: number }>()
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), DECISION_TIMEOUT_MS)
        try {
          const result = await ctx.experimental.generate.decisions(
            { model: { providerID, id: canonicalId }, input: reqInput, questions },
            { signal: controller.signal },
          )
          for (const a of mapServerJudgeAnswers(result.answers, names)) {
            byKey.set(a.key, buildVerdict(a.key, a.probability, KEEP_THRESHOLD))
          }
        } catch {
          // Fail open below: unanswered questions keep-all, never cached.
        } finally {
          clearTimeout(timer)
        }
        pendingIndexes.forEach((origIdx, pos) => {
          const verdict = byKey.get(names[pos]!)
          if (verdict)
            judgeCache.set(cacheKeys[origIdx]!, {
              keep: verdict.keep,
              reason: verdict.reason,
              confidence: verdict.confidence,
            })
        })
        return {
          verdicts: candidates.map((c, i) => {
            const hit = cachedHits[i]
            if (hit) return { key: refKey(c.ref), keep: hit.keep, reason: hit.reason, confidence: hit.confidence }
            const verdict = byKey.get(refKey(c.ref))
            // Unanswered questions were never cached: keep-all without persisting a drop.
            return verdict
              ? { key: refKey(c.ref), keep: verdict.keep, reason: verdict.reason, confidence: verdict.confidence }
              : { key: refKey(c.ref), keep: true, reason: "no answer: heuristic fallback" }
          }),
        }
      },
      resolveModel: async (input) => {
        const providerID = input.providerID.trim()
        const label = decisionProviderLabel(providerID)
        const raw = (input.model ?? "").trim()
        if (!raw) {
          const canonical = defaultModelForProvider(providerID)
          if (!canonical)
            return {
              status: "unverified" as const,
              message: `No default for this provider — enter a model. Judging will try it and fall back to heuristic on failure.`,
            }
          return {
            status: "default" as const,
            canonical,
            message: `Empty uses the provider default (${canonical}).`,
          }
        }
        const syntax = validateModelSyntax(raw)
        if (!syntax.ok) return { status: "invalid" as const, message: syntax.reason }
        // Registry reads, location-scoped: "live" means available in OpenCode,
        // never endpoint-verified. Discovery failures fall back to
        // known/unverified — a failed read never reports "invalid".
        const [modelsResult, providersResult] = await Promise.all([
          ctx.model.list().catch(() => undefined),
          ctx.provider.list().catch(() => undefined),
        ])
        const registryModels = toRegistryModels(modelsResult?.data ?? [])
        const modelsListed = modelsResult !== undefined
        const match = matchRegistryModel(registryModels, providerID, raw)
        const providerAvailable =
          providersResult?.data.some((p) => p.id === providerID) ??
          registryModels.some((m) => m.providerID === providerID)
        const { status, canonical } = resolveModelStatus({
          requested: raw,
          defaultModel: defaultModelForProvider(providerID),
          listed: match !== undefined,
          decisionCapable:
            match === undefined ? undefined : match.type === "decision" ? true : match.type !== undefined ? false : undefined,
          providerAvailable,
          modelsListed,
          knownModels: knownModelsForProvider(providerID),
          authoritativeList: isAuthoritativeProvider(providerID),
        })
        // Canonical identity is the matched registry ID; otherwise the request.
        const id = status === "live" && match ? match.id : (canonical ?? raw)
        const contextLength = match?.contextLength
        switch (status) {
          case "live":
            return {
              status,
              canonical: id,
              ...(contextLength !== undefined ? { contextLength } : {}),
              message:
                contextLength !== undefined
                  ? `Resolves to ${id} · ${contextLength.toLocaleString("en-US")} tokens context.`
                  : `${id} is available in OpenCode.`,
            }
          case "known":
            return { status, canonical: id, message: `${id} is a known ${label} decision model.` }
          case "invalid":
            return {
              status,
              canonical: id,
              message: match
                ? `${id} is available in OpenCode but does not serve decisions.`
                : `Not in the ${label} decisions list.`,
            }
          case "unverified":
            if (match) {
              return {
                status,
                canonical: id,
                message: `${id} is available in OpenCode but its decision support is unknown; judging will try it and fall back to heuristic on failure.`,
              }
            }
            if (!modelsListed) {
              return {
                status,
                canonical: id,
                message: `${label} model list unreachable; judging will try it and fall back to heuristic on failure.`,
              }
            }
            return {
              status,
              canonical: id,
              message: providerAvailable
                ? `Not in the visible ${label} list; judging will try it and fall back to heuristic on failure.`
                : `${label} is unavailable in this project; judging will try it and fall back to heuristic on failure.`,
            }
          case "default":
            return { status, canonical: id, message: `Empty uses the provider default (${id}).` }
        }
      },
    })
  },
})
