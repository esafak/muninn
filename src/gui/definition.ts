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
    provider: Schema.String,
    repo: Repo,
    number: Schema.Number,
    title: Schema.String,
    state: Schema.Literals(["open", "closed"]),
    url: Schema.String,
    updatedAt: Schema.Number,
  }),
  Schema.Struct({
    kind: Schema.Literal("run"),
    provider: Schema.String,
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
    provider: Schema.String,
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
    cache: Store.global(Schema.Struct({ entries: Schema.Record(Schema.String, Entity) }), { entries: {} }),
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
      "auth.unresolved": "{count} references couldn't be read — they look private. Connect your forge or run `gh auth login`, then reopen this session.",
      "panel.error": "Couldn't reach the forge ({message}). Fix credentials or connection, then switch sessions to retry.",
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
