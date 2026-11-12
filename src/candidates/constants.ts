/**
 * Rule-11 module: every question, threshold, weight, and timeout the judge
 * policy uses lives here. Tune thresholds on labeled traffic; re-fit after
 * any model change. Provider/model IDs live in the provider-layer registry
 * (`src/providers/decision-catalog.ts`) — never here.
 */

/** Noul instruction builder: one atomic judgment per candidate. */
export const trackInstruction = (input: {
  number: number
  kind?: string
  tier: string
  snippet: string
  command?: string
  title?: string
  state?: string
}): string => {
  const kind = input.kind ?? "reference"
  const where = input.command ? ` from \`${input.command}\`` : ""
  const hydrated = input.title ?? input.state ? ` Known details: ${[input.title, input.state].filter(Boolean).join(" · ")}.` : ""
  return (
    `Does this excerpt show the session working on ${kind} #${input.number}${where}, ` +
    `rather than merely listing or encountering it in passing? ` +
    `Excerpt (${input.tier}): """${input.snippet.slice(0, 800)}""".${hydrated} ` +
    `Answer yes only when the excerpt singles this ${kind} out as work to track.`
  )
}

/** P(yes) gate: keep at or above this. No human-review band in this UI —
 * the fallback is heuristic keep-all in code, never a review queue. */
export const KEEP_THRESHOLD = 0.7

export const DECISION_TIMEOUT_MS = 60_000

/** Heuristic listing guard. Permissive mode (model on) only keeps the huge-run guard. */
export const PERMISSIVE_LISTING_THRESHOLD = 10
