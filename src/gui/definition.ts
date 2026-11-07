import { Plugin } from "@opencode/plugin/gui"

export const definition = Plugin.define({
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
