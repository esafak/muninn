# Settled decisions

1. **Naming** — `muninn`; sidebar tab "Muninn".
2. **Placement** — pills above the composer (`ComposerPill` slot); the footer strip
   (`window.bottom`) was rejected but stays depicted in the mockup for reference.
3. **Pill grammar** — PR/CI first: `#4821 ✓ ready ⇢ #1043 +1`. Linked issues collapse
   to `+N` in the label; the dropdown always shows every member. Merge lives in its
   own pill beside the chain pill. Worst chain first, capped at three. Chains leave
   the row when nothing needs attention (no open PR, no in-flight/failing runs, no
   armed merge) and live on in history — except the session's own PR (repository-
   and branch-matched), which stays as a terminal "· merged" capsule until the
   session produces newer work.
4. **History shape** — triplet cards (issue → PR → runs), chronologically by last
   activity, grouped by day, runs newest-first, run rows expand to their checks.
   A flat event log was rejected.
5. **Extraction** — every user and assistant text part is scanned: provider lexicons
   (URLs, `owner/repo#7`) plus generic kind words ("PR 4821") and bare `#123`,
   resolved against the repo from the session's `git remote`. Code fences and inline
   code are stripped first. Hydration drops unresolvable numbers.
6. **Association ladder** (issue ↔ PR ↔ runs):
   - `closes` — closing keywords in the PR body (merges chains)
   - `linked` — GitHub development-link timeline events (merges; phase 2)
   - `session` — co-mention **and** PR head branch == session checkout branch (merges)
   - `references` — title/body mention without keywords (annotates only, never merges)
   Co-mention alone never merges two chains. Each chain records which rung linked it.
7. **Run scope** — runs tied to session-linked PRs/issues, plus branch-push runs on
   the session's checkout branch. Per-session history in v1; project roll-ups deferred.
8. **Subagents & tool output** — phase 2: server-side capture via session/tool hooks
   and `ctx.event.subscribe`; v1 scans mounted-session message text.
9. **Merge** — readiness = `mergeable` + every check succeeded + no
   `CHANGES_REQUESTED` in any reviewer's latest review (+ required approvals, folded
   into GitHub's `mergeable_state`). Colors: green ready · amber pending · grey
   blocked (reasons on hover). No button for drafts or read-only credentials.
   Dropdown: merge method (**only when the repo allows more than one** — single-method
   repos merge in one pick, no ask), delete tree + branch (local cleanup of a clean
   OpenCode-managed worktree after merge; remote branch deletion is left to the forge),
   and an independent opt-in fast-forward of the clean local base checkout (no merge
   commit, rebase, or force),
   and **merge when ready**
   (armed pill turns amber; re-picking cancels). The merge carries the head SHA we
   rendered — a stale render cannot merge over newer commits.
10. **SDK honesty** — ComposerPill renders `label` as text: the `⇢ #1043 +1` ships
    monochrome in v1. The chain pill + merge pill pair is two `ComposerPill`
    contributions — SDK-exact, no upstream changes. Custom label nodes are a known
    ~20-line upstream extension if the flat label feels weak in practice.
