/**
 * Inline glyphs. The app's `Icon` sprite is not part of the app-provided module set
 * for plugin bundles, so Muninn draws its own — small, `currentColor`, sized
 * for 16px boxes.
 */

import type { JSX } from "solid-js"

const svg = (body: JSX.Element, box = 16): JSX.Element => (
  <svg width="13" height="13" viewBox={`0 0 ${box} ${box}`} fill="currentColor" aria-hidden="true">
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

/** Unknown merge status. */
export const UnknownGlyph = (): JSX.Element =>
  svg(
    <g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="8" cy="8" r="6" />
      <path d="M6.5 6.2a1.6 1.6 0 1 1 2.8 1c-.6.7-1.3.8-1.3 1.8" />
      <circle cx="8" cy="11.3" r=".45" fill="currentColor" stroke="none" />
    </g>,
  )

/** ⊙→ merged pull request. */
export const MergedGlyph = (): JSX.Element =>
  svg(
    <g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="4" cy="3.5" r="1.75" />
      <circle cx="4" cy="12.5" r="1.75" />
      <circle cx="12" cy="12.5" r="1.75" />
      <path d="M4 5.5v5" />
      <path d="M4.8 5.1c1.8.5 3.2 1.6 3.6 3.6" />
    </g>,
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
      <path d="m5 5 6 6" />
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
