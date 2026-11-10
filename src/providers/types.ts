/**
 * The narrow seam every source provider implements. The split by runtime is
 * deliberate: lexicons and marks are pure (bundled into windows), while hydration
 * and merges run server-side behind the Muninn RPC — the GUI only ever sees
 * generic kinds, statuses, and this interface's outputs.
 */

import type { Entity, PullEntity, Ref, RepoRef, RunEntity } from "../model"

export type MergeMethod = "merge" | "squash" | "rebase"

/** A reference the provider recognized but could not hydrate (missing, private, or no access). */
export type Unresolved = Ref & { repo: RepoRef }

export interface Hydration {
  entities: Entity[]
  unresolved: Unresolved[]
}

/** The repo's merge policy, from the provider's repository settings. */
export interface MergeSettings {
  /** Allowed methods, in preference order. A single entry means never ask. */
  methods: MergeMethod[]
  default: MergeMethod
  /** The repo deletes head branches on merge by default (GitHub: delete_branch_on_merge). */
  deleteBranchByDefault: boolean
}

export type Auth = () => Promise<string | undefined>

export type MergeResult =
  | { merged: true }
  | { merged: false; message?: string; headChanged?: boolean; inFlight?: boolean; alreadyHandled?: boolean }

export interface SourceProvider {
  /** Registry id, e.g. "github". */
  id: string
  /** URL hosts this provider claims, e.g. ["github.com"]. Dispatch is by host. */
  hosts: readonly string[]
  /** Resolves a write/read credential; undefined means anonymous public access. */
  auth: (ctx: unknown) => Promise<string | undefined>
  /** The repo's merge policy; undefined when unknown or unsupported. */
  mergeSettings: (repo: RepoRef, auth: Auth) => Promise<MergeSettings | undefined>
  /** Hydrates references into entities; everything not hydrated is reported unresolved. */
  hydrate: (refs: readonly (Ref & { repo: RepoRef })[], sessionRepo: RepoRef | undefined, auth: Auth) => Promise<Hydration>
  /** Recent runs of one branch plus the branch's open PRs, for GUI-side association. */
  branchRuns: (repo: RepoRef, branch: string, auth: Auth) => Promise<{ runs: RunEntity[]; prs: PullEntity[] }>
  /** Merge a pull request; `expectedHeadSha` guards against stale renders. Returns a user-facing message on failure. */
  merge: (
    repo: RepoRef,
    number: number,
    method: "merge" | "squash" | "rebase",
    expectedHeadSha: string,
    auth: Auth,
  ) => Promise<MergeResult>
  /** Arms (or disarms) auto-merge: merge when checks pass and required reviews approve. */
  setAutoMerge: (
    repo: RepoRef,
    number: number,
    enable: boolean,
    method: "merge" | "squash" | "rebase",
    auth: Auth,
  ) => Promise<{ armed: boolean; message?: string }>
}
