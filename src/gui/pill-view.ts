import type { ComposerPillTone, IconName } from "@opencode/plugin/gui"
import { chainTone, latestRun, pillLeadOf, type Chain, type PillReason } from "../model"
import { pillStatusIcon, pillStatusTone } from "./pill-status"

/** One displayed pick: a chain plus the reason it earned its slot. */
export interface PillViewEntry {
  chain: Chain
  reason: PillReason
}

export interface PillViewOptions {
  waitForAllStatusChecks: boolean
  /** Whether the lead PR is armed for merge-when-ready (armed prefix). */
  armed: boolean
  /** Current braille spinner frame for the armed prefix. */
  spinFrame: string
  /** Locale lookup, e.g. `ctx.t`. */
  t: (key: string) => string
  /** Whether the pill opens a dropdown. Action-only pills (merged unpin /
   * dismiss) omit the `▾` chevron and name their action in the title instead
   * of describing a popover that never opens. Defaults to true. */
  dropdown?: boolean
}

export interface PillView {
  icon: IconName
  label: string
  tone: NonNullable<ComposerPillTone>
  title: string
}

const SHORT_LEN = 24

const short = (title: string): string => (title.length > SHORT_LEN ? `${title.slice(0, SHORT_LEN)}…` : title)

/**
 * Collapsed-pill view for exactly one pick: its own icon, tone, visible
 * kind-appropriate identity, and accessible name. Pure (no Solid, no ctx),
 * so tests cover every state. Returns `undefined` for empty chains (no
 * PRs/issues/runs) so the slot withdraws.
 */
export const pillViewForPick = (entry: PillViewEntry, opts: PillViewOptions): PillView | undefined => {
  const lead = pillLeadOf(entry.chain, entry.reason)
  const run = latestRun(entry.chain.runs)
  const tone = pillStatusTone(lead?.state, chainTone(entry.chain, opts.waitForAllStatusChecks))
  const mergeStatus = lead?.state === "open" || lead?.state === "draft" ? lead.mergeState : undefined
  const icon = pillStatusIcon(lead?.state, mergeStatus, tone)
  const pinnedSuffix = entry.reason === "pinned" ? ` · ${opts.t("pill.pinned")}` : ""
  const prefix = lead?.state === "open" && opts.armed ? `${opts.spinFrame} ` : ""
  // Action-only pills have no dropdown: the chevron goes and the title names
  // the click action (unpin for pinned chains, dismiss otherwise) instead of
  // the popover heading. The pinned suffix is subsumed by the action text.
  const dropdown = opts.dropdown ?? true
  if (lead) {
    if (lead.state === "merged" && !dropdown) {
      const action = opts.t(entry.reason === "pinned" ? "chain.unpin" : "pill.dismiss")
      return {
        icon,
        label: `${prefix}#${lead.number} · ${opts.t("state.merged")}`,
        tone,
        title: `#${lead.number} ${lead.title} · merged${
          lead.mergedAt === undefined ? "" : ` · ${new Date(lead.mergedAt).toLocaleString()}`
        } · ${action}`,
      }
    }
    // Merged pills keep the "merged" tag but drop the PR title: the collapsed
    // label is just `#number · merged`. The full title stays in the heading.
    const label =
      lead.state === "merged"
        ? `${prefix}#${lead.number} · ${opts.t("state.merged")} ▾`
        : `${prefix}#${lead.number} ${short(lead.title)} ▾`
    const title =
      lead.state === "merged"
        ? `#${lead.number} ${lead.title} · merged${
            lead.mergedAt === undefined ? "" : ` · ${new Date(lead.mergedAt).toLocaleString()}`
          }${pinnedSuffix}`
        : lead.state === "open" || lead.state === "draft"
          ? `#${lead.number} ${lead.title} · merge ${mergeStatus ?? "unknown"}${
              lead.reviewState ? ` · reviews ${lead.reviewState}` : ""
            }${pinnedSuffix}`
          : `#${lead.number} ${lead.title} · ${lead.state}${pinnedSuffix}`
    return { icon, label, tone, title }
  }
  const issue = entry.chain.issues[0]
  if (issue) {
    return {
      icon,
      label: `#${issue.number} ${short(issue.title)} ▾`,
      tone,
      title: `#${issue.number} ${issue.title} · issue ${issue.state}${pinnedSuffix}`,
    }
  }
  if (run) {
    return {
      icon,
      label:
        run.status === "succeeded"
          ? `run #${run.id} ▾`
          : `run #${run.id} · ${opts.t(`state.${run.status}`)} ▾`,
      tone,
      title: `run #${run.id} · ${run.status}${pinnedSuffix}`,
    }
  }
  return undefined
}

/**
 * Dismissal-aware selection pool: dismissed chains leave the eligible pool
 * before `pillDisplay` caps and ranks, so a removed chain frees its slot for
 * the next eligible chain and never inflates the overflow count. Pinned
 * chains bypass the pool via `pillDisplay`'s pinned param (and survive
 * `applyDismissal`), so dismissal can never suppress the pin override.
 */
export const pickableChains = (eligible: readonly Chain[], dismissed: ReadonlySet<string>): Chain[] =>
  eligible.filter((chain) => !dismissed.has(chain.key))

/** Eligible chains absent from the displayed picks (overflow row count). */
export const overflowCount = (
  eligible: readonly Chain[],
  picks: readonly Pick<PillViewEntry, "chain">[],
): number =>
  eligible.filter((chain) => !picks.some((entry) => entry.chain.key === chain.key)).length

/**
 * Visible picks after dismissal: dismissed chains drop out unless explicitly
 * pinned (pin wins — it bypasses eligibility and dismissal alike, so pinning
 * from the sidebar re-adds a hidden pill).
 */
export const applyDismissal = (
  picks: readonly PillViewEntry[],
  dismissed: ReadonlySet<string>,
): PillViewEntry[] => picks.filter((entry) => entry.reason === "pinned" || !dismissed.has(entry.chain.key))
