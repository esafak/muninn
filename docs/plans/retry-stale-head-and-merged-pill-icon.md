# Plan: Retry stale-head merges and align merged PR icons

> **Status:** Implemented; browser preview unavailable
> **Issue:** Follow-up to merged PR #20

## Context

Muninn's merge-when-ready flow can pass a cached PR head SHA to GitHub. GitHub correctly rejects the merge if the branch advanced, but the flow consumes the armed entry and reports failure instead of refreshing current PR state and retrying when the new head is still ready. Separately, the composer pill's generic gray branch icon does not visually match the merged-PR glyph in the dropdown/sidebar, so a merged PR looks merely like an open branch.

## Out of Scope

- Removing or weakening the expected-head SHA guard.
- Automatically retrying manual, one-shot merge actions after the target head changes.
- Changing merge readiness rules or bypassing current-head status/review checks.
- Changing provider-specific networking in the GUI.

## Phases

### Phase 1 — Recover safely from a stale head during merge-when-ready

**Goal:** A stale-head conflict refreshes PR state and retains the user's existing armed consent; any retry uses only refreshed data that still passes normal readiness checks.

- [x] Represent a confirmed head-changed result explicitly across provider, RPC, and GUI layers; do not infer it from a provider-specific message in GUI code.
- [x] On GitHub's stale-head conflict, confirm the current PR head differs from `expectedHeadSha`; unrelated merge conflicts remain ordinary failures.
- [x] Keep the armed entry during an in-flight attempt, using a per-PR in-flight guard to prevent duplicate merges; remove it on success or ordinary failure, but preserve it on a confirmed stale-head result only if the user has not disarmed/replaced it meanwhile.
- [x] Record the rejected SHA per PR and refuse another attempt against that same SHA; only retry when a successful refresh observes a different SHA and the normal `armedTargets`/`mergeReady` gates still pass.
- [x] Failed refreshes do not retry from cached data; confirmed closed/merged PRs drop the arm, while unresolved PRs retain consent and open-but-not-ready PRs remain armed for normal future polling.
- [x] Keep manual merges one-shot and preserve the expected-head guard; surface a useful stale-head message and refresh their displayed state.
- [x] Add pure tests for stale-head classification and retry decisions: confirmed different SHA, same SHA, failed refresh/no current SHA, readiness blocked, repeated rejected SHA, in-flight duplicate, disarmed/replaced consent, and ordinary/manual failure.
- [x] `mise x -- bun run check` and `mise x -- bun test` pass.

### Phase 2 — Make merged-state iconography consistent across pill and details

**Goal:** A merged PR uses the same recognizable glyph and success color in the pill, dropdown, and sidebar.

- [x] Reuse the available host `branch` glyph geometry for the merged marker in custom dropdown/sidebar rendering; document its source in the host icon catalog.
- [x] Give the pill's merged `branch` icon the host `success` tone instead of the default muted gray; align custom merged-marker color to the same success token while retaining warning/danger pill tones for unhealthy associated chains.
- [x] Preserve distinct open-ready, pending, blocked, and conflict icon mappings and the armed spinner.
- [ ] Test merged icon and tone together, verify dropdown/sidebar merged glyph keeps the same shape/color contract, and visually compare rendered states. (Code/tests reviewed; live browser preview unavailable.)
- [x] `mise x -- bun run check` and `mise x -- bun test` pass.

## Open Questions

- None. The host composer-pill API accepts catalog icons and success/warning/danger tones, but does not accept a custom SVG or accent tone; the shared host `branch` glyph with success tint is the provider-agnostic way to keep all views aligned.

## Acceptance Criteria

- [x] A changed PR head never bypasses readiness checks; merge-when-ready refreshes and retries only against a newly hydrated, ready head.
- [x] Manual merges remain guarded and do not silently retry a different head.
- [x] Merged PRs use a consistent branch glyph across the composer pill, dropdown, and sidebar; success is the normal merged tint, with existing warning/danger chain-health tones retained where applicable.
- [x] All phase checks pass and a reviewer signs off.
