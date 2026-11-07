/**
 * Quartermaster's server part. Runs inside the user's OpenCode server: it resolves
 * the session directory's forge repository, hydrates extracted references over the
 * provider APIs, and serves all of it to desktop windows through the RPC contract.
 * Providers register here; dispatch is by claimed host.
 */

import { Credential, Plugin } from "@opencode/plugin"
import { github } from "./providers/github"
import type { Ref, RepoRef } from "./model"
import type { SourceProvider } from "./providers/types"
import { readRemote } from "./remote"
import { Quartermaster } from "./rpc"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const exec = promisify(execFile)
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

/** Every source provider Quartermaster ships. GitLab and friends join this array. */
const sources: readonly SourceProvider[] = [github]

const sourceFor = (host: string | undefined): SourceProvider | undefined =>
  sources.find((source) => host !== undefined && source.hosts.includes(host))

export default Plugin.define({
  id: "quartermaster",
  async setup(ctx) {
    await ctx.rpc.register(Quartermaster, {
      repo: async (input) => {
        const remote = await readRemote(input.directory)
        if (!remote) return { provider: null, repo: null, authenticated: false, merge: null }

        const source = sourceFor(remote.host)
        if (!source) return { provider: null, repo: remote, authenticated: false, merge: null }

        const auth = () => source.auth(ctx)
        const authenticated = (await auth()) !== undefined
        const merge = await source.mergeSettings(remote, auth).catch(() => undefined)
        return { provider: source.id, repo: remote, authenticated, merge: merge ?? null }
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
          entities: results.flatMap((result) => result.entities),
          unresolved: results.flatMap((result) => result.unresolved),
        }
      },

      branchRuns: async (input) => {
        const repo = await readRemote(input.directory)
        const source = sourceFor(repo?.host)
        if (!repo || !source) return { runs: [], prs: [] }
        const result = await source.branchRuns(repo, input.branch, () => source.auth(ctx)).catch(() => ({ runs: [], prs: [] }))
        return { runs: result.runs, prs: result.prs }
      },
      debug: async () => ({ server: await serverBuild(), directory: pluginRoot }),
    })
  },
})
