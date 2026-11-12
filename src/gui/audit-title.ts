import { repoKey } from "../model"
import type { PullEntity, RepoRef } from "../model"

export interface AuditEntry {
  at: number
  repo: RepoRef
  number: number
  kind: "merged" | "branch-deleted" | "branch-delete-failed" | "merge-failed"
  method?: "merge" | "squash" | "rebase"
  via: "manual" | "when-ready"
  detail?: string
}

export const time = (epoch: number): string =>
  new Date(epoch).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })

/**
 * What Muninn actually did to one PR — merge, branch deletion, failures —
 * straight from the activity ledger. Hover-only on that PR's merge icon, so
 * merged chains stay compact. A merged PR with no ledger entry was merged on
 * the forge, not by Muninn.
 */
export const auditTitle = (entries: readonly AuditEntry[], pull: PullEntity): string | undefined => {
  const match = (kind: AuditEntry["kind"]) =>
    entries.find(
      (entry) => entry.kind === kind && entry.number === pull.number && repoKey(entry.repo) === repoKey(pull.repo),
    )
  const merged = match("merged")
  if (merged)
    return `${merged.method ?? "squash"} merged by Muninn (${time(merged.at)})${merged.via === "when-ready" ? " · when ready" : ""}${match("branch-deleted") ? " · branch deleted" : ""}${match("branch-delete-failed") ? " · branch deletion failed" : ""}`
  const failed = match("merge-failed")
  if (failed) return `merge failed (${time(failed.at)})${failed.detail ? ` — ${failed.detail}` : ""}`
  if (pull.state === "merged") return "merged on the forge — not by Muninn"
  return undefined
}
