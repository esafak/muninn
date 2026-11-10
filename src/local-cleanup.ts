export type CleanupChecks = {
  enabled: boolean
  merged: boolean
  sameRepo: boolean
  managedWorktree: boolean
  branchMatches: boolean
  headMatches: boolean
  clean: boolean
}

export const cleanupSessionMatches = (origin: string, current: string | undefined): boolean => origin === current
export const sessionMoveConfirmed = (actualDirectory: string | undefined, targetDirectory: string): boolean => actualDirectory === targetDirectory

export const baseCheckoutDecision = (checks: { differentTree: boolean; onBaseBranch: boolean; clean: boolean }): { move: boolean; message?: string } => {
  if (!checks.differentTree) return { move: false, message: "worktree is the canonical checkout; left it intact" }
  if (!checks.onBaseBranch) return { move: false, message: "canonical checkout is not on the PR base branch; worktree left intact" }
  if (!checks.clean) return { move: false, message: "canonical checkout has changes; worktree left intact" }
  return { move: true }
}

export const fastForwardDecision = (checks: {
  enabled: boolean
  merged: boolean
  onBaseBranch: boolean
  clean: boolean
  localOnly: number
  remoteOnly: number
}): { advance: boolean; message?: string } => {
  if (!checks.enabled) return { advance: false, message: "fast-forward is disabled" }
  if (!checks.merged) return { advance: false, message: "PR was not merged; local base left unchanged" }
  if (!checks.onBaseBranch) return { advance: false, message: "local checkout is not on the base branch" }
  if (!checks.clean) return { advance: false, message: "local base checkout has changes" }
  if (checks.localOnly > 0) return { advance: false, message: "local base has commits not present on the forge; left it unchanged" }
  if (checks.remoteOnly === 0) return { advance: false, message: "local base is already up to date" }
  return { advance: true }
}

export const shouldFastForwardBase = (enabled: boolean, merged: boolean): boolean => enabled && merged

export type FastForwardResult = { fastForwarded: boolean; message?: string }
export const safeFastForward = (operation: Promise<FastForwardResult>): Promise<FastForwardResult> =>
  operation.catch((error: unknown) => ({
    fastForwarded: false,
    message: `local fast-forward failed: ${error instanceof Error ? error.message : String(error)}`,
  }))

/** Pure safety gate shared with tests; no failed merge can reach destructive cleanup. */
export const cleanupDecision = (checks: CleanupChecks): { remove: boolean; message?: string } => {
  if (!checks.enabled) return { remove: false, message: "local cleanup is disabled" }
  if (!checks.merged) return { remove: false, message: "PR was not merged; local worktree left intact" }
  if (!checks.sameRepo) return { remove: false, message: "PR belongs to another repository; local worktree left intact" }
  if (!checks.managedWorktree) return { remove: false, message: "session is not in a registered OpenCode worktree; left it intact" }
  if (!checks.branchMatches) return { remove: false, message: "local worktree is not on the PR branch; left it intact" }
  if (!checks.headMatches) return { remove: false, message: "local branch differs from the merged PR head; left it intact" }
  if (!checks.clean) return { remove: false, message: "local worktree has changes; left it intact" }
  return { remove: true }
}

export const cleanupResultMessage = (treeRemoved: boolean, branchDeleted: boolean, detail?: string, sessionMoved = false): string => {
  const moved = sessionMoved ? "session switched to the base checkout; " : ""
  if (treeRemoved && branchDeleted) return `${moved}local tree and branch deleted`
  if (treeRemoved) return `${moved}worktree removed; local branch kept${detail ? `: ${detail}` : ""}`
  if (sessionMoved) return `${moved}old worktree left intact${detail ? `: ${detail}` : ""}`
  return detail ?? "local cleanup was skipped; tree and branch left intact"
}
