import type { IconName, ComposerPillTone } from "@opencode/plugin/gui"
import type { MergeState, PullState } from "../model"

export const pillStatusIcon = (
  state: PullState | undefined,
  mergeState: MergeState | null | undefined,
  tone: ComposerPillTone | undefined,
  fallback: IconName,
): IconName => {
  if (state === "merged") return "branch"
  if (state === "open") {
    if (mergeState === "ready") return "circle-check"
    if (mergeState === "pending") return "circle-exclamation"
    if (mergeState === "blocked" || mergeState === "conflict") return "circle-xmark"
  }
  if (tone === "success") return "circle-check"
  if (tone === "warning") return "circle-exclamation"
  if (tone === "danger") return "circle-xmark"
  return fallback
}
