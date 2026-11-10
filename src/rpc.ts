/**
 * The RPC between Muninn's server part and the desktop windows. Both sides
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

export const StatusCheckSnapshot = z.object({
  headSha: z.string(),
  state: z.enum(["available", "unavailable", "unsupported"]),
  contexts: z.array(z.object({ name: z.string(), status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]) })),
})

export const RunEntity = z.object({
  kind: z.literal("run"),
  provider: z.string(),
  repo: RepoRef,
  id: z.number(),
  name: z.string(),
  headBranch: z.string(),
  headSha: z.string(),
  series: z.object({ key: z.string(), sequence: z.number() }).optional(),
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
  mergedAt: z.number().optional(),
  headBranch: z.string(),
  baseBranch: z.string(),
  closes: z.array(z.number()),
  headSha: z.string(),
  url: z.string(),
  updatedAt: z.number(),
  // Optional: entries hydrated by older server code predate these.
  nodeId: z.string().optional(),
  mergeState: z.enum(["ready", "pending", "blocked", "conflict"]).nullish(),
  reviewState: z.enum(["approved", "changes_requested", "pending"]).nullish(),
  autoMerge: z.enum(["merge", "squash", "rebase"]).nullish(),
  statusChecks: StatusCheckSnapshot.optional(),
})

export const Entity = z.discriminatedUnion("kind", [IssueEntity, PullEntity, RunEntity])

/**
 * Hydration is best-effort by design: references that resolve to nothing (a `#123`
 * that is prose, a run of another repository) are simply absent from the output.
 */
export const Muninn = Rpc.define({
  id: "muninn",
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
      output: z.object({ runs: z.array(RunEntity), prs: z.array(PullEntity) }),
    },
    /** Build identity of the loaded server part, for the GUI's debug footer. */
    debug: {
      input: z.object({}),
      output: z.object({ server: z.string(), directory: z.string() }),
    },
    /** Merge a pull request. `expectedHeadSha` guards against stale renders. */
    merge: {
      input: z.object({
        directory: z.string(),
        number: z.number(),
        method: z.enum(["merge", "squash", "rebase"]),
        expectedHeadSha: z.string(),
      }),
      output: z.object({
        merged: z.boolean(),
        message: z.string().optional(),
        headChanged: z.boolean().optional(),
        inFlight: z.boolean().optional(),
        alreadyHandled: z.boolean().optional(),
      }),
    },
    /** Check the exact local tree and head before a worktree can be removed. */
    checkLocalWorktree: {
      input: z.object({ directory: z.string(), branch: z.string(), expectedHeadSha: z.string() }),
      output: z.object({ eligible: z.boolean(), message: z.string().optional() }),
    },
    /** Delete a local PR branch after a clean OpenCode worktree has been removed. */
    deleteLocalBranch: {
      input: z.object({ directory: z.string(), branch: z.string(), expectedHeadSha: z.string() }),
      output: z.object({ deleted: z.boolean(), message: z.string().optional() }),
    },
    /** Fast-forward a clean local base checkout to its forge's base branch. */
    fastForwardBase: {
      input: z.object({ directory: z.string(), repo: RepoRef, baseBranch: z.string() }),
      output: z.object({ fastForwarded: z.boolean(), message: z.string().optional() }),
    },
    /** Arms (enable) or disarms auto-merge: merge when checks pass and required reviews approve. */
    autoMerge: {
      input: z.object({
        directory: z.string(),
        number: z.number(),
        enable: z.boolean(),
        method: z.enum(["merge", "squash", "rebase"]),
      }),
      output: z.object({ armed: z.boolean(), message: z.string().optional() }),
    },
  },
  events: {},
})
export type MuninnRpc = typeof Muninn
