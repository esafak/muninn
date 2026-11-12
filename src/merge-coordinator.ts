import type { MergeResult } from "./providers/types"

/** Cross-window dedupe grace: long enough to collapse double-clicks and two
 * windows firing together, short enough that an open-after-merged
 * (forge reported merged but hydration still sees open via eventual
 * consistency) retries without a server restart. */
export const RESULT_TTL_MS = 60_000
const RESULT_MAX_ENTRIES = 1024
const active = new Set<string>()
const completed = new Map<string, { headSha: string; at: number }>()
const rejected = new Map<string, { at: number }>()
const rejectionKey = (key: string, headSha: string): string => `${key}\u0000${headSha}`

/** Serializes merge attempts per PR for this server lifetime and deduplicates
 * confirmed outcomes across GUI windows. This is intentionally process-local. */
export const coordinateMerge = async (
  key: string,
  expectedHeadSha: string,
  merge: () => Promise<MergeResult>,
  now = Date.now(),
): Promise<MergeResult> => {
  for (const [candidate, result] of completed)
    if (now - result.at >= RESULT_TTL_MS) completed.delete(candidate)
  for (const [candidate, result] of rejected)
    if (now - result.at >= RESULT_TTL_MS) rejected.delete(candidate)

  while (completed.size > RESULT_MAX_ENTRIES) {
    const oldest = [...completed].toSorted((left, right) => left[1].at - right[1].at)[0]
    if (!oldest) break
    completed.delete(oldest[0])
  }
  while (rejected.size > RESULT_MAX_ENTRIES) {
    const oldest = [...rejected].toSorted((left, right) => left[1].at - right[1].at)[0]
    if (!oldest) break
    rejected.delete(oldest[0])
  }

  const done = completed.get(key)
  if (done?.headSha === expectedHeadSha) return { merged: false, alreadyHandled: true }
  if (active.has(key)) return { merged: false, inFlight: true }
  const staleKey = rejectionKey(key, expectedHeadSha)
  if (rejected.has(staleKey))
    return { merged: false, headChanged: true, message: "This head was already rejected as stale" }

  active.add(key)
  try {
    const result = await merge()
    if (!result.merged && result.headChanged) rejected.set(staleKey, { at: now })
    if (result.merged) completed.set(key, { headSha: expectedHeadSha, at: now })
    return result
  } finally {
    active.delete(key)
  }
}
