import { Schema } from "effect"
import { Plugin, Store } from "@opencode/plugin/gui"

// The store decodes with Effect Schema while the RPC validates with zod — an SDK
// split (stores are Effect, Rpc is zod), so these shapes mirror src/rpc.ts. Keep
// them aligned.
const Repo = Schema.Struct({ host: Schema.String, owner: Schema.String, repo: Schema.String })
const RunStatus = Schema.Literals(["queued", "running", "succeeded", "failed", "cancelled"])
const StatusCheckSnapshot = Schema.Struct({
  headSha: Schema.String,
  state: Schema.Literals(["available", "unavailable", "unsupported"]),
  contexts: Schema.Array(Schema.Struct({ name: Schema.String, status: RunStatus })),
})

const Entity = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("issue"),
    // Optional: entities hydrated by older server code predate provider stamping.
    provider: Schema.optional(Schema.String),
    repo: Repo,
    number: Schema.Number,
    title: Schema.String,
    state: Schema.Literals(["open", "closed"]),
    url: Schema.String,
    updatedAt: Schema.Number,
  }),
  Schema.Struct({
    kind: Schema.Literal("run"),
    provider: Schema.optional(Schema.String),
    repo: Repo,
    id: Schema.Number,
    name: Schema.String,
    headBranch: Schema.String,
    headSha: Schema.String,
    series: Schema.optional(Schema.Struct({ key: Schema.String, sequence: Schema.Number })),
    status: RunStatus,
    checks: Schema.Array(Schema.Struct({ name: Schema.String, status: RunStatus })),
    pullRequests: Schema.Array(Schema.Number),
    url: Schema.String,
    updatedAt: Schema.Number,
  }),
  Schema.Struct({
    kind: Schema.Literal("pr"),
    provider: Schema.optional(Schema.String),
    repo: Repo,
    number: Schema.Number,
    title: Schema.String,
    state: Schema.Literals(["open", "draft", "merged", "closed"]),
    mergedAt: Schema.optional(Schema.Number),
    headBranch: Schema.String,
    baseBranch: Schema.String,
    closes: Schema.Array(Schema.Number),
    headSha: Schema.String,
    url: Schema.String,
    updatedAt: Schema.Number,
    // Optional: entries hydrated by older server code predate these.
    nodeId: Schema.optional(Schema.String),
    mergeState: Schema.optional(Schema.NullOr(Schema.Literals(["ready", "pending", "blocked", "conflict"]))),
    reviewState: Schema.optional(Schema.NullOr(Schema.Literals(["approved", "changes_requested", "pending"]))),
    autoMerge: Schema.optional(Schema.NullOr(Schema.Literals(["merge", "squash", "rebase"]))),
    statusChecks: Schema.optional(StatusCheckSnapshot),
  }),
])

export const definition = Plugin.define({
  stores: {
    /**
     * Hydrated entity cache, keyed by `host/owner/repo#kind<number>`. Persisted
     * under `plugin.muninn.cache`, so reopening a session renders its
     * chains instantly; values were validated by the RPC boundary on the way in.
     */
    cache: Store.global(
      Schema.Struct({
        entries: Schema.Record(Schema.String, Entity),
        at: Schema.Record(Schema.String, Schema.Number),
      }),
      { entries: {}, at: {} },
    ),
    /** User preferences from the plugin's settings page. */
    settings: Store.global(
      Schema.Struct({
        retentionDays: Schema.Number,
        debugMode: Schema.Boolean,
        mergeMethod: Schema.Literals(["squash", "merge", "rebase"]),
        /** Clean up the local OpenCode worktree and branch after a successful merge. */
        deleteBranch: Schema.Boolean,
        /** Fast-forward the clean local base checkout after a successful merge. */
        fastForwardBase: Schema.optional(Schema.Boolean),
        waitForAllStatusChecks: Schema.optional(Schema.Boolean),
        /** Toggle for the one-shot decision-model judge after hydration.
         * Off keeps today's heuristic tier rules; on relaxes the listing guard
         * and judges survivors semantically. Failures fall back to heuristic.
         * Keys stay server-only. */
        decisionModelsEnabled: Schema.optional(Schema.Boolean),
        /** Which OpenCode provider judges relevance when the toggle is on.
         * A Model.Ref providerID (openai ChatGPT sub, openrouter, opencode
         * Console/Go, google) — auth is the user's connected account, the
         * plugin holds no keys. No legacy values: hard transition. */
        candidateProviderID: Schema.optional(Schema.String),
        /** Pinned model ID for the judge (per-provider default when blank). */
        candidateModel: Schema.optional(Schema.String),
      }),
      { retentionDays: 30, debugMode: true, mergeMethod: "squash", deleteBranch: true, fastForwardBase: false, waitForAllStatusChecks: true, decisionModelsEnabled: false, candidateProviderID: "opencode" as const },
    ),
    /** Pull requests Muninn is driving to merge ("merge when ready"): armed
     * locally, fired by Muninn's refresh cycle once checks and reviews are green. */
    armed: Store.global(
      Schema.Struct({
        entries: Schema.Array(
          Schema.Struct({
            repo: Repo,
            number: Schema.Number,
            method: Schema.Literals(["merge", "squash", "rebase"]),
            armID: Schema.optional(Schema.String),
          }),
        ),
      }),
      { entries: [] },
    ),
    /** Evidence of Muninn's own actions: merges fired, branch deletions, failures.
     * The chain cards render this as the audit line on merged PRs. */
    activity: Store.global(
      Schema.Struct({
        entries: Schema.Array(
          Schema.Struct({
            at: Schema.Number,
            repo: Repo,
            number: Schema.Number,
            kind: Schema.Literals(["merged", "branch-deleted", "branch-delete-failed", "merge-failed"]),
            method: Schema.optional(Schema.Literals(["merge", "squash", "rebase"])),
            via: Schema.Literals(["manual", "when-ready"]),
            detail: Schema.optional(Schema.String),
          }),
        ),
      }),
      { entries: [] },
    ),
    /** Sidebar pin overriding the pill: single pinned PR (repo+number, survives
     * lead changes) or chain key for issue/run-only groups. Empty = unpinned.
     * `owner` is the session that pinned it: only that session may expire it,
     * so another session in the same repo can never erase a valid pin. */
    pinned: Store.global(
      Schema.Struct({
        repo: Schema.optional(Repo),
        number: Schema.optional(Schema.Number),
        kind: Schema.optional(Schema.Literals(["pr", "issue", "run"])),
        key: Schema.optional(Schema.String),
        owner: Schema.optional(Schema.String),
      }),
      {},
    ),
  },
  i18n: {
    en: {
      "tab.title": "Muninn",
      "pill.title": "Session sources",
      "pill.linked": "linked",
      "empty.title": "No linked sources yet.",
      "empty.body": "Mention a pull request, issue, or run — like `PR 123` — and it shows up here with live status.",
      "repo.reading": "Reading the session's repository…",
      "repo.none": "No git remote found in this workspace.",
      "auth.note": "Public repositories only. Connect your forge in Settings › Integrations for private repos and higher rate limits.",
      "auth.unresolved.one": "{{count}} reference couldn't be read — check it exists in this repo. Private repos need a forge connection or `gh auth login`.",
      "auth.unresolved.other": "{{count}} references couldn't be read — check they exist in this repo. Private repos need a forge connection or `gh auth login`.",
      "panel.error": "Couldn't reach the forge ({{message}}). Fix credentials or connection, then switch sessions to retry.",
      "panel.error.copy": "Copy error details",
      "panel.error.copied": "Copied",
      "settings.title": "Muninn",
      "settings.description": "How source references are extracted, refreshed and remembered in your sessions.",
      "settings.section.caching": "Caching",
      "settings.retention": "History retention duration",
      "settings.retention.description": "Pull requests, issues and runs stay in the sidebar and pills for this long.",
      "settings.retention.days": "days",
      "settings.debug": "Debug mode",
      "settings.debug.description": "Show the diagnostics footer (build SHAs, pill state, hydration stats) at the bottom of the panel.",
      "settings.waitForAllStatusChecks": "Wait for all status checks",
      "settings.waitForAllStatusChecks.description": "Wait for all check-runs and commit status contexts on the current pull request head. Neutral and skipped check-runs count as complete.",
      "settings.mergeMethod": "Merge method",
      "settings.mergeMethod.description": "How Muninn merges: squash, merge commit, or rebase.",
      "settings.deleteBranch": "Delete branch after merge",
      "settings.deleteBranch.description": "Delete the clean local tree and branch after a successful merge.",
      "settings.fastForwardBase": "Fast-forward clean base",
      "settings.fastForwardBase.description": "Fast-forward the clean local base checkout after a successful merge, when safe.",
      "settings.section.decisionModels": "Decision models",
      "settings.decisionModelsEnabled": "Decision models",
      "settings.decisionModelsEnabled.description": "Off keeps heuristic rules.",
      "settings.candidateProviderID": "Decision provider",
      "settings.candidateProviderID.description": "Which connected OpenCode provider judges relevance when decision models are on.",
      "settings.candidateProviderID.opencode": "Console",
      "settings.candidateProviderID.openrouter": "OpenRouter",
      "settings.candidateProviderID.openai": "OpenAI",
      "settings.candidateProviderID.google": "Google",
      "settings.candidateProviderID.__custom": "Custom…",
      "settings.candidateModel": "Decision model",
      "settings.candidateModel.description": "Pinned model ID (e.g. jev-1.13, gemini-decision-1). Empty uses the provider default.",
      "settings.candidateModel.checking": "Checking model…",
      "chain.pin": "Pin to pill",
      "chain.unpin": "Unpin from pill",
      "pill.pinned": "pinned",
      "settings.section.merging": "Merging",
      "state.open": "open",
      "state.pr-conflict": "Pull request has merge conflicts",
      "state.draft": "draft",
      "state.merged": "merged",
      "state.closed": "closed",
      "state.queued": "queued",
      "state.running": "running",
      "state.succeeded": "succeeded",
      "state.failed": "failed",
      "state.cancelled": "cancelled",
      "footer.closes": "Closes",
      "footer.updated": "updated",
      "footer.branch": "on",
    },
  },
})
