/**
 * Deterministic relevance policy: combines heuristic provenance with the
 * model's typed verdicts. Pure and GUI-safe. The model never decides identity
 * (`#42` as issue vs PR is resolved here, in code); it only judges relevance
 * of an already-identified entity.
 */

export type Kinded = "issue" | "pr" | "run"

/**
 * Whether a bare (kind-less) ref survives, determined over its ACTUAL
 * hydrated kinds — not over whichever verdict keys happen to exist. A bare
 * ref drops only when every hydrated kind carries an explicit drop; an
 * unanswered kind (verdict missing, e.g. cut off by the 64-cap or by a
 * partial typed expansion) fails open. With no hydrated kinds (unresolved),
 * the bare-keyed verdict applies, defaulting to keep.
 */
export const bareSurvives = (
  judged: Map<string, boolean> | undefined,
  base: string,
  number: number,
  hydratedKinds: readonly Kinded[],
): boolean => {
  if (!judged) return true
  if (hydratedKinds.length === 0) return judged.get(`${base}#${number}`) !== false
  return hydratedKinds.some((kind) => {
    const k = `${base}#${kind}${number}`
    return !judged.has(k) || judged.get(k) !== false
  })
}

/** Whether one hydrated kind of a bare ref survives. Unknown verdicts keep. */
export const bareKindKept = (
  judged: Map<string, boolean> | undefined,
  base: string,
  number: number,
  kind: Kinded,
): boolean => !judged || judged.get(`${base}#${kind}${number}`) !== false
