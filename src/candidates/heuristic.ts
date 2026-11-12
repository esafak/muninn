/**
 * Heuristic implementation: today's tier rules, extracted verbatim.
 * Default and current behavior. Pure and GUI-safe: no Node, no network.
 *
 * Strict mode == `deliberateRefs` exactly (LISTING_THRESHOLD 3, run-limit 6).
 * Permissive mode (DecisionModel on) relaxes the per-kind listing guard to 10
 * so the model — which sees `bucket + command` — judges borderline 3–9
 * enumerations semantically instead of dropping them by count. The huge-run
 * guard stays: paying hydrate+LLM for 50 `gh run list` rows is never worth it.
 */

import { deliberateRefs, scanDetailed, RUN_LISTING_LIMIT } from "../extract"
import type { Buckets, Tier, TieredRef } from "../extract"
import { refKey } from "../model"
import type { Lexicon } from "../providers/lexicon"
import type { RepoRef } from "../model"
import { PERMISSIVE_LISTING_THRESHOLD } from "./constants"
import type { CandidateSnippet } from "./types"

const tierRank: Record<Tier, number> = { user: 0, command: 1, prose: 2, output: 3 }

export const heuristicExtract = (
  buckets: Buckets,
  repo: RepoRef | undefined,
  lexicons: readonly Lexicon[] = [],
  mode: "strict" | "permissive" = "strict",
): { refs: TieredRef[]; snippets: Map<string, CandidateSnippet> } => {
  if (mode === "strict") {
    const refs = deliberateRefs(buckets, repo, lexicons)
    return { refs, snippets: snippetMap(buckets, refs, repo, lexicons) }
  }
  const listingThreshold = PERMISSIVE_LISTING_THRESHOLD
  const byKey = new Map<string, TieredRef>()
  const put = (ref: TieredRef) => {
    const key = refKey(ref)
    const existing = byKey.get(key)
    if (!existing || tierRank[ref.tier] < tierRank[existing.tier]) byKey.set(key, ref)
  }
  const addBlock = (text: string, tier: Tier) => {
    const detailed = scanDetailed(text, repo, lexicons)
    const runRefs = detailed.filter((r) => r.kind === "run")
    const listedRuns =
      runRefs.length >= RUN_LISTING_LIMIT
        ? new Set(runRefs.filter((r) => r.origin !== "kindword").map((r) => refKey(r)))
        : new Set<string>()
    for (const ref of detailed) {
      if (listedRuns.has(refKey(ref))) continue
      const { origin: _origin, ...rest } = ref
      put({ ...rest, tier })
    }
  }
  for (const text of buckets.user) addBlock(text, "user")
  for (const text of buckets.commands) addBlock(text, "command")
  for (const text of buckets.prose) addBlock(text, "prose")
  for (const output of buckets.outputs) {
    for (const text of output.texts) {
      const detailed = scanDetailed(text, repo, lexicons)
      const runRefs = detailed.filter((r) => r.kind === "run")
      const listedRuns =
        runRefs.length >= RUN_LISTING_LIMIT
          ? new Set(runRefs.filter((r) => r.origin !== "kindword").map((r) => refKey(r)))
          : new Set<string>()
      const refs = detailed.filter((r) => !listedRuns.has(refKey(r)))
      const perKind = new Map<string, number>()
      for (const ref of refs) {
        const group = ref.kind ?? "bare"
        perKind.set(group, (perKind.get(group) ?? 0) + 1)
      }
      for (const ref of refs) {
        const group = ref.kind ?? "bare"
        if ((perKind.get(group) ?? 0) < listingThreshold) {
          const { origin: _origin, ...rest } = ref
          put({ ...rest, tier: "output" })
        }
      }
    }
  }
  const refs = [...byKey.values()]
  return { refs, snippets: snippetMap(buckets, refs, repo, lexicons) }
}

/** First bucket string (plus invoking command for outputs) that yields each ref. */
export const snippetMap = (
  buckets: Buckets,
  refs: readonly TieredRef[],
  repo: RepoRef | undefined,
  lexicons: readonly Lexicon[] = [],
): Map<string, CandidateSnippet> => {
  const wanted = new Set(refs.map((ref) => refKey(ref)))
  const out = new Map<string, CandidateSnippet>()
  const consider = (text: string, command?: string) => {
    if (out.size >= wanted.size) return
    for (const ref of scanDetailed(text, repo, lexicons)) {
      const { origin: _origin, ...rest } = ref
      void rest
      const key = refKey(ref)
      if (wanted.has(key) && !out.has(key)) out.set(key, { text, ...(command ? { command } : {}) })
    }
  }
  for (const text of buckets.user) consider(text)
  for (const text of buckets.commands) consider(text)
  for (const text of buckets.prose) consider(text)
  for (const output of buckets.outputs) for (const text of output.texts) consider(text, output.command)
  return out
}
