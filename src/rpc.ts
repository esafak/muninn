/**
 * The RPC between Quartermaster's server part and the desktop windows. Both sides
 * and any future provider plugin import this one contract — the only shared
 * runtime token in the package.
 */

import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"

export const RepoRef = z.object({
  host: z.string(),
  owner: z.string(),
  repo: z.string(),
})

export const Ref = z.object({
  number: z.number().int().positive(),
  kind: z.enum(["issue", "pr", "run"]).optional(),
  repo: RepoRef.optional(),
})

export const Check = z.object({
  name: z.string(),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
})

export const RunEntity = z.object({
  kind: z.literal("run"),
  provider: z.string(),
  repo: RepoRef,
  id: z.number(),
  name: z.string(),
  headBranch: z.string(),
  headSha: z.string(),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  checks: z.array(Check),
  pullRequests: z.array(z.number()).default([]),
  url: z.string(),
  updatedAt: z.number(),
})

export const IssueEntity = z.object({
  kind: z.literal("issue"),
  provider: z.string(),
  repo: RepoRef,
  number: z.number(),
  title: z.string(),
  state: z.enum(["open", "closed"]),
  url: z.string(),
  updatedAt: z.number(),
})

export const PullEntity = z.object({
  kind: z.literal("pr"),
  provider: z.string(),
  repo: RepoRef,
  number: z.number(),
  title: z.string(),
  state: z.enum(["open", "draft", "merged", "closed"]),
  headBranch: z.string(),
  baseBranch: z.string(),
  closes: z.array(z.number()),
  headSha: z.string(),
  url: z.string(),
  updatedAt: z.number(),
})

export const Entity = z.discriminatedUnion("kind", [IssueEntity, PullEntity, RunEntity])

/**
 * Hydration is best-effort by design: references that resolve to nothing (a `#123`
 * that is prose, a run of another repository) are simply absent from the output.
 */
export const Quartermaster = Rpc.define({
  id: "quartermaster",
  methods: {
    /** Resolves the session directory's forge repository, from `git remote`. */
    repo: {
      input: z.object({ directory: z.string() }),
      output: z.object({
        provider: z.string().nullable(),
        repo: RepoRef.nullable(),
        /** Whether a write/read credential is available (authenticated requests, private repos). */
        authenticated: z.boolean(),
        /** The repo's merge policy; null when the provider is unknown or unsupported. */
        merge: z
          .object({
            methods: z.array(z.enum(["merge", "squash", "rebase"])),
            default: z.enum(["merge", "squash", "rebase"]),
            deleteBranchByDefault: z.boolean(),
          })
          .nullable(),
      }),
    },
    /** Hydrates references into live entities; everything not hydrated is reported unresolved. */
    hydrate: {
      input: z.object({ directory: z.string(), refs: z.array(Ref).max(64) }),
      output: z.object({
        entities: z.array(Entity),
        unresolved: z.array(z.object({ number: z.number(), repo: RepoRef, kind: z.string().optional() })),
      }),
    },
    /** Recent CI runs of one branch: the standalone cards of the history panel. */
    branchRuns: {
      input: z.object({ directory: z.string(), branch: z.string() }),
      output: z.object({ runs: z.array(RunEntity) }),
    },
  },
  events: {},
})
export type QuartermasterRpc = typeof Quartermaster
