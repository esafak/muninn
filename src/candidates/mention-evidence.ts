/**
 * Mention evidence for the pill's concurrent-PR dots: which hydrated PRs the
 * session deliberately references. Pure and GUI-safe.
 *
 * Inputs are pre-resolved by the caller: heuristic survivors (`filteredRefs`,
 * already past the DecisionModel filter) plus the hydrated entity cache plus
 * the applicable PR-kind verdicts. The helper resolves refs to repo-scoped PR
 * entity keys:
 *
 * - Only `user`/`command`/`prose` tiers recruit; `output` never does.
 * - Typed `pr` refs recruit their hydrated PR unless its PR-kind verdict is
 *   explicitly `false`. Missing, pending, failed, disabled, or capped-out
 *   verdicts do NOT exclude (fail-open kept).
 * - Bare refs fan out over hydrated kinds like `rechain` does: the PR kind is
 *   checked with `bareKindKept`, so a bare ref kept via its issue while its PR
 *   was dropped does NOT recruit the PR.
 * - Issue/run mentions never recruit related PRs (no SHA/series fan-in here).
 * - Same-repo gating lives in `pillEligible`, not here: this set is keyed by
 *   repo-scoped entity keys, and foreign PRs stay excluded at eligibility.
 */

import type { TieredRef } from "../extract"
import { bareKindKept } from "./filtering"
import type { Entity } from "../model"
import { entityKey, repoKey } from "../model"

export const mentionEvidence = (
  refs: readonly TieredRef[],
  entities: Readonly<Record<string, Entity>>,
  judged: Map<string, boolean> | undefined,
): ReadonlySet<string> => {
  const out = new Set<string>()
  for (const ref of refs) {
    if (ref.tier === "output") continue
    if (ref.kind === "pr" && ref.repo) {
      const base = repoKey(ref.repo)
      if (judged?.get(`${base}#pr${ref.number}`) === false) continue
      const entity = entities[`${base}#pr${ref.number}`]
      if (entity?.kind === "pr") out.add(entityKey(entity))
      continue
    }
    if (!ref.kind && ref.repo) {
      const base = repoKey(ref.repo)
      if (!bareKindKept(judged, base, ref.number, "pr")) continue
      const entity = entities[`${base}#pr${ref.number}`]
      if (entity?.kind === "pr") out.add(entityKey(entity))
    }
  }
  return out
}
