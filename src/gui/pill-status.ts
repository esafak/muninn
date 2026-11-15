import type { IconName, ComposerPillTone } from "@opencode/plugin/gui"
import type { MergeState, PullState } from "../model"

// No fallback: a pill only renders when there is something to show (a PR
// lead or a run), so the icon is always a status circle/branch. PR presence
// alone decides the circle — tone/mergeState only pick which one.
export const pillStatusIcon = (
  state: PullState | undefined,
  mergeState: MergeState | null | undefined,
  tone: ComposerPillTone | undefined,
): IconName => {
  if (state === "merged") return "branch"
  if (state === "closed") return "circle-xmark"
  if (state === "open" || state === "draft") {
    if (mergeState === "ready") return "circle-check"
    if (mergeState === "pending") return "circle-exclamation"
    if (mergeState === "blocked" || mergeState === "conflict") return "circle-xmark"
    // Unknown merge state on an open/draft PR is still in-flight: tone wins
    // when present, otherwise default to the pending mark.
    if (tone === "success") return "circle-check"
    if (tone === "danger") return "circle-xmark"
    return "circle-exclamation"
  }
  if (tone === "success") return "circle-check"
  if (tone === "danger") return "circle-xmark"
  return "circle-exclamation"
}

// Aggregate icon for multi-pick capsules: the icon summarizes the group,
// the label identifies its lead (picks[0], pinned-first). A per-pick circle
// would contradict the aggregate tone (e.g. a ready lead's check in danger
// red when a sibling fails), and chainTone can report danger while that same
// PR's mergeState stays ready — so shape must derive from tone alone.
export const aggregateStatusIcon = (
  tone: NonNullable<ComposerPillTone>,
): IconName => {
  if (tone === "danger") return "circle-xmark"
  if (tone === "warning") return "circle-exclamation"
  return "circle-check"
}
// Total: every rendered pill gets a status tone. Merged keeps success
// (warning/danger preserved if the chain somehow reports them), closed is
// danger, open/draft default to warning, run-only defaults to its chain tone
// or warning — never undefined, so the host never falls back to black.
export const pillStatusTone = (
  state: PullState | undefined,
  tone: ComposerPillTone | undefined,
): NonNullable<ComposerPillTone> => {
  if (state === "merged") {
    if (tone === "warning" || tone === "danger") return tone
    return "success"
  }
  if (state === "closed") return "danger"
  return tone ?? "warning"
}
