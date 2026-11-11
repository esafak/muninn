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

const containsPath = (parent: string, child: string): boolean => {
  const normalized = parent.replace(/[\\/]+$/, "")
  const prefix = normalized ? `${normalized}/` : "/"
  return child === normalized || child.startsWith(prefix) || (normalized !== "" && child.startsWith(`${normalized}\\`))
}

export const worktreeOccupancyDecision = (
  sessions: readonly {
    id: string
    directory: string
    parentID?: string
    outcome?: "succeeded" | "failed" | "interrupted"
    time?: { busy?: number; idle?: number; archived?: number }
  }[],
  originSessionID: string,
  directory: string,
  originMoved: boolean,
): { safe: boolean; message?: string } => {
  const occupants = sessions.filter((session) => {
    if (!containsPath(directory, session.directory)) return false
    // Completed agent children remain in session.list after their work is done.
    const finishedChild =
      session.id !== originSessionID &&
      session.parentID !== undefined &&
      session.outcome !== undefined &&
      session.time?.busy !== undefined &&
      session.time.idle !== undefined &&
      session.time.busy <= session.time.idle
    return !finishedChild
  })
  if (originMoved) {
    // The caller confirms the move through session.get; session.list can lag behind it.
    if (occupants.every((session) => session.id === originSessionID)) return { safe: true }
    return { safe: false, message: "another session still uses the old worktree; left it intact" }
  }
  if (occupants.length === 1 && occupants[0]!.id === originSessionID) return { safe: true }
  if (occupants.some((session) => session.id !== originSessionID))
    return { safe: false, message: "another session uses the worktree; left it intact" }
  return { safe: false, message: "origin session is not confirmed as the sole worktree user; left it intact" }
}

export const shouldRecordCleanupFailure = (branchDeleteAttempted: boolean, deleted: boolean): boolean => branchDeleteAttempted && !deleted

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

/** Case-insensitive repo equality for remote matching (hosts, owners, and names). */
export const isSameRepo = (
  a: { host: string; owner: string; repo: string },
  b: { host: string; owner: string; repo: string },
): boolean =>
  a.host.toLowerCase() === b.host.toLowerCase() &&
  a.owner.toLowerCase() === b.owner.toLowerCase() &&
  a.repo.toLowerCase() === b.repo.toLowerCase()

/** First remote whose parsed URL directly matches the expected repo. Pure: no network. */
export const selectDirectRemote = (
  candidates: readonly { name: string; remote: { host: string; owner: string; repo: string } | undefined }[],
  expected: { host: string; owner: string; repo: string },
): string | undefined =>
  candidates.find((candidate) => candidate.remote !== undefined && isSameRepo(candidate.remote, expected))?.name

/** First same-host remote whose canonical repo matches the expected repo (renames).
 * Pure: canonical answers are supplied by the caller; failures (undefined) never match
 * and never block later candidates. */
export const selectCanonicalRemote = (
  candidates: readonly { name: string; remote: { host: string; owner: string; repo: string } | undefined }[],
  expected: { host: string; owner: string; repo: string },
  canonicalByName: ReadonlyMap<string, { host: string; owner: string; repo: string } | undefined>,
): string | undefined => {
  for (const candidate of candidates) {
    if (candidate.remote === undefined) continue
    if (candidate.remote.host.toLowerCase() !== expected.host.toLowerCase()) continue
    if (isSameRepo(candidate.remote, expected)) continue
    const canonical = canonicalByName.get(candidate.name)
    if (canonical !== undefined && isSameRepo(canonical, expected)) return candidate.name
  }
  return undefined
}

export type FastForwardResult = { fastForwarded: boolean; message?: string }
export const safeFastForward = (operation: Promise<FastForwardResult>): Promise<FastForwardResult> =>
  operation.catch((error: unknown) => ({
    fastForwarded: false,
    message: `local fast-forward failed: ${error instanceof Error ? error.message : String(error)}`,
  }))

/** Where a session directory lives: a linked OpenCode worktree, a project
 * canonical checkout, or outside managed checkouts. Pure routing input for
 * post-merge cleanup: worktrees are removed, canonicals switch branches. */
export type CheckoutKind = "worktree" | "canonical" | "unmanaged"

export const locateCheckout = (
  projects: readonly { canonical: string; trees: readonly string[] }[],
  directory: string,
): CheckoutKind => {
  for (const project of projects) {
    if (project.trees.includes(directory)) return "worktree"
    if (project.canonical === directory) return "canonical"
  }
  return "unmanaged"
}

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
