/**
 * Judicious caching: per-ref, no TTL, bounded.
 *
 * Key = hash(refKey + tier + snippet + command + title + state + judge scope).
 * Identical evidence hits; new wording, tier promotion (`output` → `prose`),
 * or new hydrated titles/states miss and re-judge. No TTL: re-judging
 * identical evidence after N minutes costs money for no new information and
 * flip-flops on Noul noise (0.43↔0.53).
 *
 * Scope: the verdict cache lives in the server process (setup closure) and
 * is bounded (oldest-first eviction past `CACHE_MAX_ENTRIES`). It is NOT
 * tied to `retentionDays` (that lifecycle owns hydrated entities in the GUI
 * cache) and does NOT survive restarts. Session/model/snippet scoping of
 * *reads* happens at the call site (`filteredRefs` + stale-response
 * rejection in `window.tsx`), not in this store.
 */

import { refKey } from "../model"
import type { JudgeInput } from "./types"

/** Process-bound verdict entries; evicted oldest-first past the cap. */
export const CACHE_MAX_ENTRIES = 2000

export const candidateCacheKey = (input: JudgeInput, scope: string): string => {
  const material = [
    input.ref ? refKey(input.ref) : "",
    input.ref.tier,
    input.snippet,
    input.command ?? "",
    input.title ?? "",
    input.state ?? "",
    scope,
  ].join("\n")
  let hash = 0x811c9dc5
  for (let i = 0; i < material.length; i++) {
    hash ^= material.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `cand:${(hash >>> 0).toString(16)}`
}

export const createCandidateCache = (maxEntries = CACHE_MAX_ENTRIES) => {
  const kept = new Map<string, { keep: boolean; reason?: string; confidence?: number }>()
  return {
    get: (key: string) => kept.get(key),
    set: (key: string, value: { keep: boolean; reason?: string; confidence?: number }) => {
      if (!kept.has(key) && kept.size >= maxEntries) {
        const oldest = kept.keys().next()
        if (!oldest.done) kept.delete(oldest.value)
      }
      kept.set(key, value)
    },
    size: () => kept.size,
    clear: () => kept.clear(),
  }
}

export type CandidateCache = ReturnType<typeof createCandidateCache>
