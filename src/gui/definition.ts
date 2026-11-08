import { Schema } from "effect"
import { Plugin, Store } from "@opencode/plugin/gui"

// The store decodes with Effect Schema while the RPC validates with zod — an SDK
// split (stores are Effect, Rpc is zod), so these shapes mirror src/rpc.ts. Keep
// them aligned.
const Repo = Schema.Struct({ host: Schema.String, owner: Schema.String, repo: Schema.String })
const RunStatus = Schema.Literals(["queued", "running", "succeeded", "failed", "cancelled"])

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
    headBranch: Schema.String,
    baseBranch: Schema.String,
    closes: Schema.Array(Schema.Number),
    headSha: Schema.String,
    url: Schema.String,
    updatedAt: Schema.Number,
  }),
])

export const definition = Plugin.define({
  stores: {
    /**
     * Hydrated entity cache, keyed by `host/owner/repo#kind<number>`. Persisted
     * under `plugin.quartermaster.cache`, so reopening a session renders its
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
      Schema.Struct({ retentionDays: Schema.Number, debugMode: Schema.Boolean }),
      { retentionDays: 30, debugMode: true },
    ),
  },
  i18n: {
    en: {
      "tab.title": "Quartermaster",
      "pill.title": "Session sources",
      "pill.linked": "linked",
      "empty.title": "No linked sources yet.",
      "empty.body": "Mention a pull request, issue, or run — like `PR 123` — and it shows up here with live status.",
      "repo.reading": "Reading the session's repository…",
      "repo.none": "No git remote found in this workspace.",
      "auth.note": "Public repositories only. Connect your forge in Settings › Integrations for private repos and higher rate limits.",
      "auth.unresolved": "{count} references couldn't be read — check they exist in this repo. Private repos need a forge connection or `gh auth login`.",
      "panel.error": "Couldn't reach the forge ({message}). Fix credentials or connection, then switch sessions to retry.",
      "settings.title": "Quartermaster",
      "settings.description": "How source references are extracted, refreshed and remembered in your sessions.",
      "settings.section.caching": "Caching",
      "settings.retention": "Keep history",
      "settings.retention.description": "Days to remember pull requests, issues and runs before they age out of the sidebar and pills.",
      "settings.retention.days": "days",
      "settings.debug": "Debug mode",
      "settings.debug.description": "Show the diagnostics footer (build SHAs, pill state, hydration stats) at the bottom of the panel.",
      "state.open": "open",
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
