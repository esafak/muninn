/**
 * Inline glyphs. The app's `Icon` sprite is not part of the app-provided module set
 * for plugin bundles, so Muninn draws its own — small, `currentColor`, sized
 * for 16px boxes.
 */

import type { JSX } from "solid-js"

const svg = (body: JSX.Element, box = 16, size = 13): JSX.Element => (
  <svg width={size} height={size} viewBox={`0 0 ${box} ${box}`} fill="currentColor" aria-hidden="true">
    {body}
  </svg>
)

/** The GitHub mark: the product mark on every issue and pull-request row. */
export const GitHubMark = (): JSX.Element =>
  svg(
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.65-.01 1.11.6 1.27.85.75 1.26 1.96.9 2.44.69.08-.54.29-.9.52-1.11-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />,
  )

/** ⊙ open issue; the dot fills when closed. */
export const IssueGlyph = (props: { closed?: boolean }): JSX.Element =>
  svg(
    <g>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5" />
      <circle cx="8" cy="8" r="2.4" />
    </g>,
  )

/** ⇅ pull request arrows. */
export const PullGlyph = (): JSX.Element =>
  svg(
    <g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="4" cy="3.5" r="1.75" />
      <circle cx="4" cy="12.5" r="1.75" />
      <circle cx="12" cy="12.5" r="1.75" />
      <path d="M4 5.5v5M12 10.5V6a2 2 0 0 0-2-2H8.5" />
      <path d="m10 2.5-1.8 1.8L10 6.1" />
    </g>,
  )

/** Tabler-style pull request with conflicts, matched to Muninn's stroke and node sizing. */
export const PullConflictGlyph = (): JSX.Element => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M15.375 20.2a2.625 2.625 0 1 0 5.25 0a2.625 2.625 0 0 0 -5.25 0" />
    <path d="M11 6h5a2 2 0 0 1 2 2v8" />
    <path d="M3.375 20.2a2.625 2.625 0 1 0 5.25 0a2.625 2.625 0 0 0 -5.25 0" />
    <path d="M6 11v5" />
    <path d="M4 4l4 4" />
    <path d="M8 4l-4 4" />
  </svg>
)

/**
 * GitHub's pin octicon: the pushpin Muninn's sidebar pin uses. `solid` drops
 * the inner groove detail so the pinned state reads as one solid fill.
 */
export const PinGlyph = (props: { solid?: boolean }): JSX.Element =>
  svg(
    props.solid ? (
      <path d="m11.294.984 3.722 3.722a1.75 1.75 0 0 1-.504 2.826l-1.327.613a3.089 3.089 0 0 0-1.707 2.084l-.584 2.454c-.317 1.332-1.972 1.8-2.94.832L5.75 11.311 1.78 15.28a.749.749 0 1 1-1.06-1.06l3.969-3.97-2.204-2.204c-.968-.968-.5-2.623.832-2.94l2.454-.584a3.08 3.08 0 0 0 2.084-1.707l.613-1.327a1.75 1.75 0 0 1 2.826-.504Z" />
    ) : (
      <path d="m11.294.984 3.722 3.722a1.75 1.75 0 0 1-.504 2.826l-1.327.613a3.089 3.089 0 0 0-1.707 2.084l-.584 2.454c-.317 1.332-1.972 1.8-2.94.832L5.75 11.311 1.78 15.28a.749.749 0 1 1-1.06-1.06l3.969-3.97-2.204-2.204c-.968-.968-.5-2.623.832-2.94l2.454-.584a3.08 3.08 0 0 0 2.084-1.707l.613-1.327a1.75 1.75 0 0 1 2.826-.504ZM6.283 9.723l2.732 2.731a.25.25 0 0 0 .42-.119l.584-2.454a4.586 4.586 0 0 1 2.537-3.098l1.328-.613a.25.25 0 0 0 .072-.404l-3.722-3.722a.25.25 0 0 0-.404.072l-.613 1.328a4.584 4.584 0 0 1-3.098 2.537l-2.454.584a.25.25 0 0 0-.119.42l2.731 2.732Z" />
    ),
  )

/** Unknown merge status. */
export const UnknownGlyph = (): JSX.Element =>
  svg(
    <g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="8" cy="8" r="6" />
      <path d="M6.5 6.2a1.6 1.6 0 1 1 2.8 1c-.6.7-1.3.8-1.3 1.8" />
      <circle cx="8" cy="11.3" r=".45" fill="currentColor" stroke="none" />
    </g>,
  )

/** Host `branch` glyph from packages/ui/src/icons/catalog.ts, shared for merged PRs. */
export const MergedGlyph = (): JSX.Element =>
  svg(
    <path
      d="M5.118 5.686V10.314M5.118 5.686C5.97 5.686 6.661 4.995 6.661 4.143C6.661 3.291 5.97 2.6 5.118 2.6C4.266 2.6 3.575 3.291 3.575 4.143C3.575 4.995 4.266 5.686 5.118 5.686ZM5.118 10.314C4.266 10.314 3.575 11.005 3.575 11.857C3.575 12.709 4.266 13.4 5.118 13.4C5.97 13.4 6.661 12.709 6.661 11.857M5.118 10.314C5.97 10.314 6.661 11.005 6.661 11.857M10.882 5.686C11.734 5.686 12.425 4.995 12.425 4.143C12.425 3.291 11.734 2.6 10.882 2.6C10.03 2.6 9.339 3.291 9.339 4.143C9.339 4.995 10.03 5.686 10.882 5.686ZM10.882 5.686V9.457C10.882 10.783 9.807 11.857 8.482 11.857H6.661"
      fill="none"
      stroke="currentColor"
      stroke-width="1"
      stroke-linecap="round"
      stroke-linejoin="round"
    />,
    16,
    14,
  )

/** ○ queued run: a clock face. */
export const QueuedGlyph = (): JSX.Element =>
  svg(
    <g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" />
    </g>,
  )

/** ✓ succeeded. */
export const CheckGlyph = (): JSX.Element =>
  svg(
    <g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="8" cy="8" r="6" />
      <path d="m5.2 8.2 1.9 1.9 3.7-4" />
    </g>,
  )

/** ✗ failed. */
export const CrossGlyph = (): JSX.Element =>
  svg(
    <g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
      <circle cx="8" cy="8" r="6" />
      <path d="m5.8 5.8 4.4 4.4m0-4.4-4.4 4.4" />
    </g>
  )

/** ⊘ cancelled. */
export const CancelledGlyph = (): JSX.Element =>
  svg(
    <g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
      <circle cx="8" cy="8" r="6" />
      <path d="m5 11 6-6" />
    </g>,
  )

/** GitHub's merge-status mark: a circle with a center dot, colored by the
 * chain's merge state (green ready, amber pending, red blocked). */
export const MergeGlyph = (): JSX.Element =>
  svg(
    <>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5" />
      <circle cx="8" cy="8" r="2.2" />
    </>,
  )

/** Two overlapping sheets: copy. */
export const CopyGlyph = (): JSX.Element =>
  svg(
    <g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V3.75A1.75 1.75 0 0 0 8.75 2h-5A1.75 1.75 0 0 0 2 3.75v5A1.75 1.75 0 0 0 3.75 10.5H5.5" />
    </g>,
  )
