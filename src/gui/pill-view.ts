import type { IconName } from "@opencode/plugin/gui"
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
  /** Ticker step for truncated names; short names ignore it and stay static. */
  marqueeOffset?: number
}

export interface PillView {
  icon: IconName
  label: string
  tone: NonNullable<import("@opencode/plugin/gui").ComposerPillTone>
  title: string
}

const SHORT_LEN = 24

const short = (title: string): string => (title.length > SHORT_LEN ? `${title.slice(0, SHORT_LEN)}…` : title)

/**
 * Ticker window for a truncated name: scrolls a `SHORT_LEN` window around
 * `title + gap` so the full name drifts past. Short names stay static.
 * Offset 0 matches `short` (static truncated form, no jump on first paint).
 */
export const marquee = (title: string, offset = 0): string => {
  if (title.length <= SHORT_LEN || offset <= 0) return short(title)
  const loop = `${title}   `
  const start = offset % loop.length
  return (loop + loop).slice(start, start + SHORT_LEN)
}

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
  const name = (title: string): string => marquee(title, opts.marqueeOffset)
  if (lead) {
    const label =
      lead.state === "merged"
        ? `${prefix}#${lead.number} ${name(lead.title)} · ${opts.t("state.merged")} ▾`
        : `${prefix}#${lead.number} ${name(lead.title)} ▾`
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
      label: `#${issue.number} ${name(issue.title)} ▾`,
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

/** Slot lookup: the pick rendered in a collapsed slot (withdrawn when empty). */
export const slotEntry = (
  picks: readonly PillViewEntry[],
  index: number,
): PillViewEntry | undefined => picks[index]

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

/** Stable signature of the displayed picks: keys, freshness, and reason. */
export const marqueeFingerprint = (
  picks: readonly { chain: Pick<Chain, "key" | "updatedAt">; reason: PillReason }[],
): string => picks.map((entry) => `${entry.chain.key}@${entry.chain.updatedAt}@${entry.reason}`).join("|")

/**
 * Tick count for one full pass over the longest truncated name (gap
 * included), or `undefined` when nothing scrolls. Completion parks back at
 * step 0 — the static truncated form, never a shifted frame.
 */
export const marqueeTotal = (longest: number): number | undefined =>
  longest <= SHORT_LEN ? undefined : longest - SHORT_LEN + 3
