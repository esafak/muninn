/**
 * Coalescing for automatic recovery refreshes. A poll that fires while an
 * identical refresh (same session + directory) is still pending must skip
 * instead of starting overlapping work: every refresh resets `meta.repo` to
 * null up front, so a second start discards the first before repository
 * discovery commits. Session changes (different key) and explicit targeted
 * refreshes always run — they supersede stale work via the generation guard.
 */

/** Identity of one refresh attempt: session plus checkout directory. */
export const refreshKeyFor = (id: string, directory: string): string => `${id}\n${directory}`

/**
 * Whether an automatic refresh may start. Runs when no refresh is active, or
 * when the active refresh belongs to another session/directory (it will be
 * superseded). Skips when the identical refresh is already pending.
 */
export const shouldRunAutoRefresh = (activeKey: string | undefined, currentKey: string): boolean =>
  activeKey !== currentKey

/**
 * Whether a finishing refresh may clear the active marker. Only the latest
 * refresh for its key clears; a superseded attempt leaves the newer owner's
 * marker alone.
 */
export const shouldClearActiveRefresh = (
  activeKey: string | undefined,
  activeGeneration: number,
  finishedKey: string,
  finishedGeneration: number,
): boolean => activeKey === finishedKey && activeGeneration === finishedGeneration
