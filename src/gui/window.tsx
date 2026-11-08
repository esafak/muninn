import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import type { JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { ComposerPill, MenuItem, Panel, SettingsPage, createKeyed, usePlugin, type IconName, type Plugin } from "@opencode/plugin/gui"
import { associate } from "../associate"
import { scan } from "../extract"
import type { Chain, Entity, RepoRef, RunEntity } from "../model"
import { chainTone, refKey, repoKey } from "../model"
import { githubLexicon } from "../providers/github/lexicon"
import { Quartermaster } from "../rpc"
import type { definition } from "./definition"
import { History } from "./history"
import { pillIcon } from "./marks"

const POLL_MS = 30_000
/** Debounce for scan → hydrate while a message streams in. */
const HYDRATE_DEBOUNCE_MS = 600

const entityKey = (entity: Entity): string =>
  `${repoKey(entity.repo)}#${entity.kind}${entity.kind === "run" ? entity.id : entity.number}`

export const setup: Plugin.Setup<typeof definition> = (ctx) => {
  injectStyles()

  const [meta, setMeta] = createStore({
    sessionID: "",
    repo: null as RepoRef | null,
    provider: null as string | null,
    branch: "",
    authenticated: false,
    unresolved: 0,
    error: null as string | null,
    debug: null as string | null,
    stats: null as string | null,
  })
  const DAY_MS = 24 * 60 * 60 * 1000
  // Hydrated entities, seeded from the durable cache (global stores load before
  // setup) and written through on every merge, so session reopen renders instantly.
  // Entries live for the configured retention days, then the lifecycle prunes them.
  const retentionMs = () => Math.max(1, Math.round(ctx.stores.settings.value.retentionDays)) * DAY_MS
  const cached = (): Record<string, Entity> => {
    // The store decodes the readonly flavor; entities are only ever read here.
    const entries = ctx.stores.cache.value.entries as Record<string, Entity>
    const { at } = ctx.stores.cache.value
    const cutoff = Date.now() - retentionMs()
    const fresh: Record<string, Entity> = {}
    // Entries written before the `at` stamps existed (schema migration) read as
    // fresh rather than being filtered out by the lifecycle on first load.
    for (const [key, entity] of Object.entries(entries)) if ((at[key] ?? Date.now()) > cutoff) fresh[key] = entity
    return fresh
  }
  const [entities, setEntities] = createStore<Record<string, Entity>>(cached())

  const merge = (hydrated: readonly Entity[]) => {
    setEntities((previous) => {
      const next = { ...previous }
      for (const entity of hydrated) next[entityKey(entity)] = entity
      return next
    })
    ctx.stores.cache.update((draft) => {
      const cutoff = Date.now() - retentionMs()
      for (const [key, stamped] of Object.entries(draft.at)) if (stamped < cutoff) delete draft.entries[key]
      for (const entity of hydrated) {
        draft.entries[entityKey(entity)] = entity
        draft.at[entityKey(entity)] = Date.now()
      }
    })
  }
  const [runs, setRuns] = createStore<Record<string, readonly RunEntity[]>>({})
  const [chains, setChains] = createSignal<readonly Chain[]>([])
  const [sessionReady, setSessionReady] = createSignal(false)

  const session = () => ctx.sessions.current()

  /** All text Quartermaster may scan, from the mounted session's messages. Typed
   * from the SDK so a wrong field fails the build instead of starving the scan. */
  const text = () => {
    const current = session()
    if (!current) return ""
    const out: string[] = []
    for (const message of current.server.data.session.message.list(current.id)) {
      if (message.type === "user") {
        out.push(message.text)
        continue
      }
      if (message.type !== "assistant") continue
      for (const part of message.content) {
        if (part.type === "text" || part.type === "reasoning") out.push(part.text)
        if (part.type !== "tool") continue
        const state = part.state
        if (state.status === "completed") {
          const command = state.input.command
          if (typeof command === "string") out.push(command)
          for (const block of state.content) if (block.type === "text") out.push(block.text)
        }
      }
    }
    return out.join("\n")
  }

  const refs = createMemo(() => scan(text(), meta.repo ?? undefined, [githubLexicon]))

  const rechain = () => {
    const repo = meta.repo
    // Chains are session-associated: only entities this session's transcript
    // references join, joined against the (global, durable) entity cache. Bare
    // references don't know their kind — try all three. Runs pull in their pull
    // requests (matched by head SHA), so the association is visible without a mention.
    const relevant = refs().flatMap((ref) => {
      if (ref.kind) {
        const entity = entities[refKey(ref)]
        return entity ? [entity] : []
      }
      if (!ref.repo) return []
      const base = repoKey(ref.repo)
      return (["issue", "pr", "run"] as const)
        .map((kind) => entities[`${base}#${kind}${ref.number}`])
        .filter((entity): entity is Entity => entity !== undefined)
    })
    const related: Entity[] = []
    for (const entity of relevant) {
      if (entity.kind !== "run") continue
      for (const candidate of Object.values(entities)) {
        if (candidate.kind !== "pr") continue
        if (
          candidate.repo.host !== entity.repo.host ||
          candidate.repo.owner !== entity.repo.owner ||
          candidate.repo.repo !== entity.repo.repo
        )
          continue
        if (candidate.headSha === entity.headSha && !relevant.includes(candidate) && !related.includes(candidate))
          related.push(candidate)
      }
    }
    setChains(associate([...relevant, ...related], repo ? (runs[repoKey(repo)] ?? []) : []))
  }

  const open = (url: string) => ctx.system.openExternal(url)

  /** Re-reads repository coordinates, then hydrates and re-chains. Cheap when cached. */
  const refresh = async () => {
    const current = session()
    if (!current) return
    setSessionReady(true)
    // Gate pills on this session before any network: identity is known up front.
    setMeta((previous) => ({ ...previous, sessionID: current.id, repo: null, provider: null, branch: "" }))
    const client = ctx.client

    try {
      const info = await client.rpc(Quartermaster).repo({ directory: current.directory })
      setMeta({
        sessionID: current.id,
        repo: info.repo,
        provider: info.provider,
        authenticated: info.authenticated,
        branch: "",
      })
      if (!info.repo) {
        setMeta("error", null)
        return
      }

      const vcs = await client.vcs.get({ location: { directory: current.directory } }).catch(() => undefined)
      const branch = vcs?.data?.branch?.current
      setMeta("branch", branch ?? "")

      const found = refs()
      if (found.length > 0) {
        const result = await client.rpc(Quartermaster).hydrate({ directory: current.directory, refs: found })
        merge(result.entities)
        setMeta("unresolved", result.unresolved.length)
        const byKind = new Map<string, number>()
        for (const entity of result.entities) byKind.set(entity.kind, (byKind.get(entity.kind) ?? 0) + 1)
        const breakdown = [...byKind].map(([kind, count]) => `${count} ${kind}`).join(", ") || "none"
        setMeta("stats", `${found.length} refs → ${result.entities.length} hydrated (${breakdown}) · ${result.unresolved.length} unresolved`)
      }
      if (branch) {
        const { runs: branchRuns, prs } = await client.rpc(Quartermaster).branchRuns({ directory: current.directory, branch })
        setRuns(repoKey(info.repo), branchRuns)
        merge(prs)
      }
      setMeta("error", null)
      rechain()
    } catch (error) {
      setMeta("error", error instanceof Error ? error.message : String(error))
    }

    const dbg = await client.rpc(Quartermaster).debug({}).catch(() => null)
    setMeta("debug", dbg ? `srv ${dbg.server}` : "srv ?")
  }

  // Session (or its directory) changed: re-read everything.
  createKeyed(
    () => `${session()?.key ?? ""}\n${session()?.directory ?? ""}`,
    () => {
      // Entities persist across sessions (they are repo-keyed): reseed from the
      // durable cache rather than clearing.
      setEntities(cached())
      setRuns({})
      setChains([])
      setSessionReady(false)
      void refresh()
    },
  )

  // Messages changed: re-hydrate after a short debounce, so streaming text settles.
  let timer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    const found = refs()
    if (!meta.repo || found.length === 0) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      const current = session()
      if (!current) return
      void ctx.client
        .rpc(Quartermaster)
        .hydrate({ directory: current.directory, refs: found })
        .then(({ entities: hydrated, unresolved }) => {
          merge(hydrated)
          setMeta("unresolved", unresolved.length)
          rechain()
        })
        .catch(() => undefined)
    }, HYDRATE_DEBOUNCE_MS)
  })

  // CI state changes upstream: poll while this session has anything to show.
  const poll = setInterval(() => {
    if (chains().length > 0) void refresh()
  }, POLL_MS)
  onCleanup(() => {
    clearInterval(poll)
    clearTimeout(timer)
  })

  // ── Component 1: pills above the composer ────────────────────────────────
  // Live chains only: merged, closed and settled work drops out of the pill row
  // (the history panel keeps it) — so backfilling an old session stays quiet.
  // Run-only chains are the exception: they exist because the session explicitly
  // referenced a run, so they stay until a day passes without activity.
  const live = (chain: Chain): boolean =>
    chain.prs.some((pull) => pull.state === "open" || pull.state === "draft") ||
    chain.runs.some((run) => run.status === "queued" || run.status === "running" || run.status === "failed") ||
    (chain.prs.length === 0 && chain.issues.some((issue) => issue.state === "open")) ||
    (chain.prs.length === 0 && chain.issues.length === 0 && Date.now() - chain.updatedAt < DAY_MS)

  // Diagnostics footer: the pill's full decision state, plus which builds are loaded.
  const debugLine = () => {
    const current = session()
    const gate = current?.id === meta.sessionID ? "✓" : "✗"
    const list = chains().filter((chain) => live(chain))
    const primary = list[0]?.prs[0] ?? list[0]?.issues[0]
    const pill =
      list.length === 0
        ? "off: no live chains"
        : primary
          ? `#${primary.number} ${primary.title.slice(0, 36)}`
          : list[0]!.runs[0]
            ? `run #${list[0]!.runs[0].id}`
            : "off"
    return `qm gui ${__QM_BUILD__}${meta.debug ? ` · ${meta.debug}` : " · srv ?"} · gate ${gate} · chains ${chains().length} · live ${list.length} · pill: ${pill}${meta.stats ? ` · ${meta.stats}` : ""}`
  }

  ctx.add(ComposerPill, {
    id: "links",
    order: 10,
    show: (input) => {
      if (input.session.id !== meta.sessionID) return undefined
      const list = chains().filter((chain) => live(chain))
      if (list.length === 0) return undefined

      // PR chains are the primary work: they lead the pill regardless of recency,
      // with a danger PR still outranking a calm one.
      const prChains = chains().filter((chain) => chain.prs.length > 0)
      const worst = (prChains.find((chain) => chainTone(chain) === "danger") ?? prChains[0]) ?? chains()[0]!
      const lead = worst.prs[0]
      const failing = worst.runs.find((run) => run.status === "failed")

      return {
        icon: pillIcon(meta.provider),
        label: lead
          ? `#${lead.number} ${lead.title}`
          : `run #${worst.runs[0]!.id} · ${ctx.t(`state.${worst.runs[0]!.status}`)}`,
        tone: chainTone(worst),
        title: ctx.t("pill.title"),
        rows: list.slice(0, 3).flatMap((chain) => {
          const rows: {
            id: string
            label: string
            icon: IconName
            tone?: "success" | "warning" | "danger"
            detail?: string
            run: () => void
          }[] = []
          for (const pr of chain.prs.slice(0, 2))
            rows.push({
              id: `${chain.key}:pr${pr.number}`,
              label: `#${pr.number} ${pr.title}`,
              icon: pillIcon(meta.provider),
              tone: chainTone(chain),
              detail: pr.headBranch,
              run: () => open(pr.url),
            })
          for (const issue of chain.issues.slice(0, 2))
            rows.push({
              id: `${chain.key}:issue${issue.number}`,
              label: `#${issue.number} ${issue.title}`,
              icon: pillIcon(meta.provider),
              detail: ctx.t(`state.${issue.state}`),
              run: () => open(issue.url),
            })
          for (const run of chain.runs.slice(0, 2))
            rows.push({
              id: `${chain.key}:run${run.id}`,
              label: `run #${run.id} · ${ctx.t(`state.${run.status}`)}`,
              icon:
                run.status === "failed"
                  ? "circle-xmark"
                  : run.status === "running"
                    ? "outline-rotate-clockwise"
                    : run.status === "succeeded"
                      ? "check"
                      : pillIcon(meta.provider),
              detail: run.name,
              run: () => open(run.url),
            })
          return rows
        }),
      }
    },
  })

  // Launcher: the side region's + menu lists Quartermaster so the tab can be opened.
  ctx.add(MenuItem, (): MenuItem => {    const current = ctx.sessions.current()

    return {
      menu: "session.panel",
      id: "open",
      title: ctx.t("tab.title"),
      icon: pillIcon(meta.provider),
      opened: !!current && ctx.layout.state(`${ctx.id}:history`, current) !== "closed",
      run: () => {
        if (current) ctx.layout.open(`${ctx.id}:history`, current)
      },
    }
  })

  // ── Component 2: the history panel in the side region ───────────────────
  const tab = {
    id: "history",
    get title() {
      return ctx.t("tab.title")
    },
    closable: "compact",
    fallback: true,
  } as const

  ctx.add(Panel, {
    id: "history",
    region: "side",
    mobile: {
      get title() {
        return ctx.t("tab.title")
      },
      order: 60,
      kind: "menu",
      icon: pillIcon(meta.provider),
    },
    list: (input) => (input.open.includes("history") ? [tab] : []),
    render: () => (
      <div class="qm-panel" data-quartermaster>
        <div class="qm-scroll" data-scrollable>
          <History
            chains={chains}
            repo={() => meta.repo}
            branch={() => meta.branch}
            authenticated={() => meta.authenticated}
            unresolved={() => meta.unresolved}
            error={() => meta.error}
            debug={debugLine}
            showDebug={() => ctx.stores.settings.value.debugMode}
            mergeReady={(chain) =>
              chain.prs.some((pr) => pr.state === "open") &&
              chain.runs.length > 0 &&
              chain.runs.every((run) => run.status === "succeeded")
            }
            mergeWhy={(chain) => {
              const failed = chain.runs.find((run) => run.status === "failed")
              if (failed) return `checks failed (run #${failed.id})`
              if (chain.runs.some((run) => run.status === "queued" || run.status === "running")) return "checks still running"
              if (chain.prs.every((pr) => pr.state !== "open")) return "pull request is not open"
              return "not ready"
            }}
            sessionReady={sessionReady}
            onOpen={open}
            onMerge={async (pull) => {
              const current = session()
              const client = ctx.client
              if (!current || !client) return
              // Merging is irreversible and remote: always confirm in the app's
              // own dialog, naming exactly what will happen.
              const ok = await ctx.dialogs.confirm({
                title: `Merge PR #${pull.number}?`,
                description: `Squash-merges "${pull.title}" into ${pull.baseBranch} and deletes the branch ${pull.headBranch}.`,
                confirm: "Merge",
                danger: true,
              })
              if (!ok) return
              await client
                .rpc(Quartermaster)
                .merge({
                  directory: current.directory,
                  number: pull.number,
                  method: "squash",
                  expectedHeadSha: pull.headSha,
                  deleteBranch: true,
                })
                .catch((error: unknown) => console.error("[quartermaster] merge failed", error))
              void refresh()
            }}
          />
        </div>
        <Show when={chains().length === 0 && meta.repo === null && !sessionReady()}>
          <div class="qm-empty" />
        </Show>
      </div>
    ),
  })

  // ── Settings: cache lifecycle, in the app's Settings › Extensions area ──
  ctx.add(SettingsPage, {
    id: "settings",
    icon: "settings-gear",
    get title() {
      return ctx.t("settings.title")
    },
    get entries() {
      return [
        {
          id: "retention",
          title: ctx.t("settings.retention"),
          description: ctx.t("settings.retention.description"),
          keywords: "cache retention days history keep sidebar",
        },
      ]
    },
    render: () => <QuartermasterSettings />,
  })
}

const QuartermasterSettings = (): JSX.Element => {
  const ctx = usePlugin<typeof definition>()
  const ui = ctx.ui
  const days = () => Math.max(1, Math.round(ctx.stores.settings.value.retentionDays))

  return (
    <ui.SettingsLayout title={ctx.t("settings.title")} description={ctx.t("settings.description")}>
      <ui.SettingsSection title={ctx.t("settings.section.caching")}>
        <ui.SettingsRow id="retention" title={ctx.t("settings.retention")} description={ctx.t("settings.retention.description")}>
          <ui.TextInput
            value={String(days())}
            label={ctx.t("settings.retention")}
            onInput={(value) => {
              const parsed = Number.parseInt(value, 10)
              if (Number.isFinite(parsed)) ctx.stores.settings.update((draft) => { draft.retentionDays = Math.min(365, Math.max(1, parsed)) })
            }}
          />
          <span class="qm-note" style={{ padding: "0 6px" }}>{ctx.t("settings.retention.days")}</span>
        </ui.SettingsRow>
        <ui.SettingsRow id="debug" title={ctx.t("settings.debug")} description={ctx.t("settings.debug.description")}>
          <ui.Switch
            checked={ctx.stores.settings.value.debugMode}
            label={ctx.t("settings.debug")}
            hideLabel
            onChange={(checked) => ctx.stores.settings.update((draft) => { draft.debugMode = checked })}
          />
        </ui.SettingsRow>
      </ui.SettingsSection>
    </ui.SettingsLayout>
  )
}

const STYLES = `
[data-quartermaster] {
  color: var(--v2-text-text-base);
  font-size: 12px;
  line-height: 1.45;
}
.qm-panel { height: 100%; min-height: 0; display: flex; flex-direction: column; }
.qm-scroll { min-height: 0; flex: 1; overflow-y: auto; padding: 10px 12px 14px; }
.qm-head { display: flex; align-items: center; gap: 6px; padding: 2px 4px 10px; color: var(--v2-text-text-muted); }
.qm-mark { color: var(--v2-icon-icon-muted); flex: none; display: inline-flex; }
.qm-repo { font-family: var(--v2-font-family-code); font-size: 11px; }
.qm-branch {
  margin-left: auto; font-size: 10.5px; font-family: var(--v2-font-family-code);
  color: var(--v2-text-text-faint); background: var(--v2-background-bg-layer-01);
  border-radius: 5px; padding: 2px 7px;
}
.qm-note { font-size: 10.5px; color: var(--v2-text-text-faint); padding: 0 4px 8px; }
.qm-note[data-warn] { color: var(--v2-state-fg-warning); }
.qm-day {
  font-size: 10px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase;
  color: var(--v2-text-text-faint); padding: 10px 4px 6px;
}
.qm-chain {
  background: var(--v2-background-bg-deep);
  border-radius: 10px;
  box-shadow: inset 0 0 0 .5px var(--v2-border-border-muted);
  padding: 4px 0 2px;
  margin-bottom: 8px;
}
.qm-chain[data-tone="danger"] { box-shadow: inset 0 0 0 .5px var(--v2-state-border-danger); }
.qm-row { position: relative; display: flex; align-items: center; gap: 8px; padding: 6px 10px 6px 12px; border-radius: 7px; min-width: 0; }
.qm-row:hover { background: var(--v2-overlay-simple-overlay-hover); cursor: pointer; }
.qm-row.sub { padding-left: 26px; }
.qm-row.sub::before { content: ""; position: absolute; left: 22px; top: -4px; height: 8px; width: 1px; background: var(--v2-border-border-strong); }
.qm-kind { flex: none; display: inline-flex; }
.qm-kind[data-state="issue-open"], .qm-kind[data-state="pr-open"] { color: var(--v2-state-fg-success); }
.qm-kind[data-state="pr-draft"] { color: var(--v2-icon-icon-faint); }
.qm-kind[data-state="pr-merged"], .qm-kind[data-state="issue-closed"] { color: var(--v2-text-text-accent); }
.qm-kind[data-state="pr-closed"] { color: var(--v2-state-fg-danger); }
.qm-id { font-family: var(--v2-font-family-code); font-size: 11.5px; font-weight: 600; flex: none; cursor: copy; }
.qm-id.copied { color: var(--v2-state-fg-success); }
.qm-chain[data-stale="true"] { opacity: .55; }
.qm-title { flex: 1; min-width: 0; font-size: 12px; color: var(--v2-text-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.qm-meta { flex: none; font-size: 10.5px; color: var(--v2-text-text-faint); font-family: var(--v2-font-family-code); }
.qm-state { display: inline-flex; align-items: center; gap: 4px; flex: none; font-size: 10.5px; font-family: var(--v2-font-family-code); }
.qm-state[data-state="open"], .qm-state[data-status="succeeded"] { color: var(--v2-state-fg-success); }
.qm-state[data-state="merged"], .qm-state[data-state="closed"], .qm-state[data-status="running"] { color: var(--v2-text-text-accent); }
.qm-state[data-state="closed"][data-issue] { color: var(--v2-text-text-accent); }
.qm-state[data-state="draft"], .qm-state[data-status="queued"], .qm-state[data-status="cancelled"] { color: var(--v2-text-text-faint); }
.qm-state[data-state="closed"] { color: var(--v2-state-fg-danger); }
.qm-checks { overflow: hidden; max-height: 0; transition: max-height .18s ease; }
.qm-checks.show { max-height: 260px; }
.qm-check { display: flex; align-items: center; gap: 7px; padding: 3px 10px 3px 42px; font-size: 11px; font-family: var(--v2-font-family-code); color: var(--v2-text-text-muted); }
.qm-check-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.qm-check [data-status="succeeded"] { color: var(--v2-state-fg-success); }
.qm-check [data-status="failed"] { color: var(--v2-state-fg-danger); }
.qm-check [data-status="running"] { color: var(--v2-text-text-accent); }
.qm-check [data-status="queued"], .qm-check [data-status="cancelled"] { color: var(--v2-text-text-faint); }
.qm-chain-foot {
  display: flex; align-items: center; gap: 8px; padding: 5px 12px 6px;
  border-top: 1px solid var(--v2-border-border-muted); margin-top: 3px;
  font-size: 10.5px; color: var(--v2-text-text-faint);
}
.qm-foot-ago { margin-left: auto; }
.qm-empty { color: var(--v2-text-text-faint); font-size: 11px; padding: 6px 4px; }
.qm-debug {
  flex: none; padding: 6px 12px 0;
  font-family: var(--v2-font-family-code); font-size: 9.5px;
  color: var(--v2-text-text-faint);
  border-top: 1px dashed var(--v2-border-border-muted);
  user-select: text; cursor: pointer;
}
.qm-debug:hover { color: var(--v2-text-text-muted); }
.qm-spin {
  width: 11px; height: 11px; border-radius: 50%; flex: none;
  border: 1.5px solid var(--v2-border-border-strong); border-top-color: var(--v2-text-text-accent);
  animation: qm-rot .9s linear infinite;
}
@keyframes qm-rot { to { transform: rotate(360deg); } }
`

let injected = false
const injectStyles = (): void => {
  if (injected || typeof document === "undefined") return
  const style = document.createElement("style")
  style.textContent = STYLES
  style.dataset.quartermaster = ""
  document.head.append(style)
  injected = true
}
