import type { IconName, ComposerPillTone } from "@opencode/plugin/gui"
import type { MergeState, PullState } from "../model"

export type MergeGlyphDisplay = {
  state: "ready" | "pending" | "blocked" | "conflict" | "unknown" | "merged"
  /** Render the cross glyph instead of the optimistic merge dot. */
  cross: boolean
}

/**
 * Display state for the merge-status glyph in the sidebar and pill popover.
 * Mirrors `pillStatusIcon`'s override policy: an adverse chain tone must not
 * leave an optimistic green ready dot on a PR Muninn won't merge (changes
 * requested, failed checks, conflict, or blocked merge state). Keeping the
 * policy here means the capsule and its detail rows cannot disagree.
 */
export const mergeGlyphDisplay = (
  state: PullState | undefined,
  mergeState: MergeState | null | undefined,
  tone: ComposerPillTone | undefined,
): MergeGlyphDisplay => {
  if (state === "merged") return { state: "merged", cross: false }
  if (tone === "danger") return { state: "blocked", cross: true }
  const shown = mergeState ?? "unknown"
  if (tone === "warning" && shown === "ready") return { state: "pending", cross: false }
  return { state: shown, cross: false }
}

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
    // Adverse chain evidence overrides optimistic merge-state glyphs: a lone
    // ready PR with failed runs / change requests (tone danger) must not
    // render a red check, and warning must not stay a green check. Blocked /
    // conflict stays xmark even under warning (more severe wins).
    if (tone === "danger") return "circle-xmark"
    if (tone === "warning") {
      if (mergeState === "blocked" || mergeState === "conflict") return "circle-xmark"
      return "circle-exclamation"
    }
    if (mergeState === "ready") return "circle-check"
    if (mergeState === "pending") return "circle-exclamation"
    if (mergeState === "blocked" || mergeState === "conflict") return "circle-xmark"
    // Unknown merge state is still in-flight: success tone proved green,
    // everything else (including no tone) keeps the pending mark.
    if (tone === "success") return "circle-check"
    return "circle-exclamation"
  }
  if (tone === "success") return "circle-check"
  if (tone === "danger") return "circle-xmark"
  return "circle-exclamation"
}

// Merged keeps success (warning/danger preserved if the chain somehow
// reports them): the host has no purple tone, so the branch glyph stays
// green with the "merged" tag. Closed is danger, open/draft default to
// warning, run-only defaults to its chain tone or warning — never undefined,
// so the host never falls back to black.
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
