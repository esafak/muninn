import { createEffect, createMemo, createSignal, onCleanup, For, Show } from "solid-js"
import type { JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { ComposerPill, MenuItem, Panel, SettingsPage, createKeyed, usePlugin, type IconName, type Plugin } from "@opencode/plugin/gui"
import { associate } from "../associate"
import { messagesText, scan } from "../extract"
import type { Chain, Entity, PullEntity, RepoRef, RunEntity, RunStatus } from "../model"
import { chainTone, armedTargets, mergeReady, mergeWhy, refKey, repoKey } from "../model"
import { githubLexicon } from "../providers/github/lexicon"
import { Muninn } from "../rpc"
import type { definition } from "./definition"
import { History, MergeButton } from "./history"
import { CancelledGlyph, CheckGlyph, CrossGlyph, IssueGlyph, MergeGlyph, MergedGlyph, PullGlyph, QueuedGlyph } from "./icons"
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

  /** All text Muninn may scan, from the mounted session's messages. The
   * SDK types the list here, so a wrong field fails the build; flattening itself
   * is `messagesText` in the tested core. */
  const text = () => {
    const current = session()
    if (!current) return ""
    return messagesText(current.server.data.session.message.list(current.id))
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
      const info = await client.rpc(Muninn).repo({ directory: current.directory })
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
        const result = await client.rpc(Muninn).hydrate({ directory: current.directory, refs: found })
        merge(result.entities)
        setMeta("unresolved", result.unresolved.length)
        const byKind = new Map<string, number>()
        for (const entity of result.entities) byKind.set(entity.kind, (byKind.get(entity.kind) ?? 0) + 1)
        const breakdown = [...byKind].map(([kind, count]) => `${count} ${kind}`).join(", ") || "none"
        setMeta("stats", `${found.length} refs → ${result.entities.length} hydrated (${breakdown}) · ${result.unresolved.length} unresolved`)
      }
      if (branch) {
        const { runs: branchRuns, prs } = await client.rpc(Muninn).branchRuns({ directory: current.directory, branch })
        setRuns(repoKey(info.repo), branchRuns)
        merge(prs)
      }
      setMeta("error", null)
      rechain()
      driveArmedMerges()
    } catch (error) {
      setMeta("error", error instanceof Error ? error.message : String(error))
    }

    const dbg = await client.rpc(Muninn).debug({}).catch(() => null)
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
        .rpc(Muninn)
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

  /** Whether a PR is armed for Muninn-driven merge-when-ready — ours, or already
   * armed on the forge's side (shown the same; cancel handles both). */
  const isArmed = (pull: PullEntity): boolean =>
    ctx.stores.armed.value.entries.some(
      (entry) => repoKey(entry.repo) === repoKey(pull.repo) && entry.number === pull.number,
    ) || !!pull.autoMerge

  /** Fires the merge RPC (head-SHA guarded; method and delete-branch from settings)
   * and toasts the outcome. No confirmation — callers own consent. */
  const fireMerge = async (pull: PullEntity, method: "merge" | "squash" | "rebase"): Promise<boolean> => {
    const current = session()
    const client = ctx.client
    if (!current || !client) return false
    const result = await client
      .rpc(Muninn)
      .merge({
        directory: current.directory,
        number: pull.number,
        method,
        expectedHeadSha: pull.headSha,
        deleteBranch: ctx.stores.settings.value.deleteBranch,
      })
      .catch((error: unknown) => ({ merged: false as const, message: error instanceof Error ? error.message : String(error) }))
    if (!result.merged) {
      ctx.toast.show({ title: `PR #${pull.number} merge failed`, description: result.message, variant: "error" })
      return false
    }
    ctx.toast.show({ title: `PR #${pull.number} merged`, description: `${method} into ${pull.baseBranch}`, variant: "success" })
    return true
  }

  /** Merges a pull request now: confirms in the app's dialog (naming exactly what
   * happens), then fires the provider merge guarded by the PR's head SHA. */
  const mergePull = async (pull: PullEntity): Promise<void> => {
    const method = ctx.stores.settings.value.mergeMethod
    const deleteBranch = ctx.stores.settings.value.deleteBranch
    const ok = await ctx.dialogs.confirm({
      title: `Merge PR #${pull.number}?`,
      description: `${method[0]!.toUpperCase()}${method.slice(1)}-merges "${pull.title}" into ${pull.baseBranch}${deleteBranch ? ` and deletes the branch ${pull.headBranch}` : ""}.`,
      confirm: "Merge",
      danger: true,
    })
    if (!ok) return
    await fireMerge(pull, method)
    void refresh()
  }

  /** Arms or disarms merge-when-ready. Arming is local — Muninn watches the chain
   * and fires the merge itself when checks and reviews are green; the forge's own
   * auto-merge is never used. Arming confirms once; that consent carries. */
  const armPull = async (pull: PullEntity, enable: boolean): Promise<void> => {
    if (enable) {
      const method = ctx.stores.settings.value.mergeMethod
      const ok = await ctx.dialogs.confirm({
        title: `Merge PR #${pull.number} when ready?`,
        description: `Muninn watches "${pull.title}" and merges into ${pull.baseBranch} with ${method} as soon as checks pass and reviews approve. You can cancel any time.`,
        confirm: "Merge when ready",
      })
      if (!ok) return
      ctx.stores.armed.update((draft) => {
        if (!draft.entries.some((entry) => repoKey(entry.repo) === repoKey(pull.repo) && entry.number === pull.number))
          draft.entries.push({ repo: pull.repo, number: pull.number, method })
      })
      void refresh()
      return
    }
    // Disarm: drop our entry; also cancel an arm the user made on the forge.
    ctx.stores.armed.update((draft) => {
      draft.entries = draft.entries.filter(
        (entry) => !(repoKey(entry.repo) === repoKey(pull.repo) && entry.number === pull.number),
      )
    })
    const current = session()
    const client = ctx.client
    if (pull.autoMerge && current && client)
      await client
        .rpc(Muninn)
        .autoMerge({ directory: current.directory, number: pull.number, enable: false, method: pull.autoMerge })
        .catch((error: unknown) => console.error("[muninn] forge disarm failed", error))
    void refresh()
  }

  /** The merge-when-ready driver: fires merges for armed entries whose chain is
   * green. Runs after every refresh cycle; consumes the entry before firing so a
   * concurrent refresh can't double-fire. */
  const driveArmedMerges = () => {
    for (const { pull, method } of armedTargets(ctx.stores.armed.value.entries, chains())) {
      ctx.stores.armed.update((draft) => {
        draft.entries = draft.entries.filter(
          (entry) => !(repoKey(entry.repo) === repoKey(pull.repo) && entry.number === pull.number),
        )
      })
      void fireMerge(pull, method).then(() => void refresh())
    }
  }

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
    return `mn gui ${__MN_BUILD__}${meta.debug ? ` · ${meta.debug}` : " · srv ?"} · gate ${gate} · chains ${chains().length} · live ${list.length} · pill: ${pill}${meta.stats ? ` · ${meta.stats}` : ""}`
  }

  const runGlyph = (status: RunStatus): JSX.Element => {
    if (status === "succeeded") return <CheckGlyph />
    if (status === "failed") return <CrossGlyph />
    if (status === "cancelled") return <CancelledGlyph />
    if (status === "running") return <span class="mn-spin" />
    return <QueuedGlyph />
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
      const tone = chainTone(worst)

      // The capsule reads like GitHub's PR status: a circle icon in the worst
      // state's color, then `#number title ⌄` — short enough that the chevron
      // (the affordance that this opens a menu) survives truncation.
      const circle =
        tone === "success" ? "circle-check" : tone === "warning" ? "circle-exclamation" : tone === "danger" ? "circle-xmark" : pillIcon(meta.provider)
      const short = (title: string): string => (title.length > 26 ? `${title.slice(0, 26)}…` : title)

      return {
        icon: circle,
        label: lead
          ? `#${lead.number} ${short(lead.title)} ▾`
          : `run #${worst.runs[0]!.id} · ${ctx.t(`state.${worst.runs[0]!.status}`)} ▾`,
        tone,
        title: lead ? `#${lead.number} ${lead.title}` : ctx.t("pill.title"),
      }
    },
    // The pill's dropdown: the full chain picture with the merge controls the
    // sidebar has, plus the merge-method/delete-branch choices. Reads the stores
    // itself, so it stays live while open. Run ids live only here (pill grammar).
    menu: (input) => {
      // The lead open PR across live chains: the footer's merge-when-ready
      // toggle binds to it. Reactive — the popover updates while it's open.
      const lead = chains()
        .filter((chain) => live(chain))
        .flatMap((chain) => chain.prs.filter((pull) => pull.state === "open").map((pull) => ({ chain, pull })))[0]
      return (
      <div class="mn-pop">
        <For each={chains().filter((chain) => live(chain)).slice(0, 3)}>
          {(chain) => (
            <div class="mn-pop-chain">
              <For each={chain.prs}>
                {(pull) => (
                  <div class="mn-pop-row" onClick={() => { input.close(); open(pull.url) }}>
                    <span class="mn-kind" data-state={`pr-${pull.state}`} title={ctx.t(`state.${pull.state}`)}>
                      {pull.state === "merged" ? <MergedGlyph /> : <PullGlyph />}
                    </span>
                    <span
                      class="mn-merge-state"
                      data-state={pull.mergeState ?? "unknown"}
                      title={`merge: ${pull.mergeState ?? "unknown"}${pull.reviewState ? ` · reviews: ${pull.reviewState}` : ""}`}
                    >
                      <MergeGlyph />
                    </span>
                    <span class="mn-pop-id">#{pull.number}</span>
                    <span class="mn-pop-title">{pull.title}</span>
                    <MergeButton chain={chain} pull={pull} isArmed={isArmed} onMerge={mergePull} onArm={armPull} />
                  </div>
                )}
              </For>
              <For each={chain.issues}>
                {(issue) => (
                  <div class="mn-pop-row" onClick={() => { input.close(); open(issue.url) }}>
                    <span class="mn-kind" data-state={`issue-${issue.state}`} title={ctx.t(`state.${issue.state}`)}>
                      <IssueGlyph closed={issue.state === "closed"} />
                    </span>
                    <span class="mn-pop-id">#{issue.number}</span>
                    <span class="mn-pop-title">{issue.title}</span>
                  </div>
                )}
              </For>
              <For each={chain.runs.slice(0, 3)}>
                {(run) => (
                  <div class="mn-pop-row" onClick={() => { input.close(); open(run.url) }}>
                    <span class="mn-kind" data-state={run.status} title={ctx.t(`state.${run.status}`)}>
                      {runGlyph(run.status)}
                    </span>
                    <span class="mn-pop-id">#{run.id}</span>
                    <span class="mn-pop-title">{run.name}</span>
                  </div>
                )}
              </For>
              <Show when={chain.runs.length > 3}>
                <div
                  class="mn-pop-more"
                  onClick={() => {
                    input.close()
                    if (input.session.id) ctx.layout.open(`${ctx.id}:history`, input.session)
                  }}
                >
                  +{chain.runs.length - 3} runs in the sidebar
                </div>
              </Show>
            </div>
          )}
        </For>
        <div class="mn-pop-foot">
          <Show when={lead}>
            {(lead) => (
              <label
                class="mn-pop-toggle"
                title={
                  isArmed(lead().pull)
                    ? `Muninn is driving the merge (${lead().pull.autoMerge ? "also armed on the forge" : "armed locally"}) — click to cancel`
                    : mergeReady(lead().chain)
                      ? "already mergeable — just Merge; nothing to wait for"
                      : `Muninn merges when checks pass and reviews approve — now blocked: ${mergeWhy(lead().chain)}`
                }
              >
                <input
                  type="checkbox"
                  checked={isArmed(lead().pull)}
                  disabled={!isArmed(lead().pull) && mergeReady(lead().chain)}
                  onChange={(event) => void armPull(lead().pull, event.currentTarget.checked)}
                />
                merge when ready
              </label>
            )}
          </Show>
          <label class="mn-pop-toggle">
            <input
              type="checkbox"
              checked={ctx.stores.settings.value.deleteBranch}
              onChange={(event) => ctx.stores.settings.update((draft) => { draft.deleteBranch = event.currentTarget.checked })}
            />
            delete branch
          </label>
          <select
            title="Merge method"
            value={ctx.stores.settings.value.mergeMethod}
            onChange={(event) => {
              const value = event.currentTarget.value
              if (value === "squash" || value === "merge" || value === "rebase")
                ctx.stores.settings.update((draft) => { draft.mergeMethod = value })
            }}
          >
            <option value="squash">squash</option>
            <option value="merge">merge commit</option>
            <option value="rebase">rebase</option>
          </select>
        </div>
      </div>
      )
    },
  })

  // Launcher: the side region's + menu lists Muninn so the tab can be opened.
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
      <div class="mn-panel" data-muninn>
        <div class="mn-scroll" data-scrollable>
          <History
            chains={chains}
            repo={() => meta.repo}
            branch={() => meta.branch}
            authenticated={() => meta.authenticated}
            unresolved={() => meta.unresolved}
            error={() => meta.error}
            debug={debugLine}
            showDebug={() => ctx.stores.settings.value.debugMode}
            sessionReady={sessionReady}
            onOpen={open}
            onMerge={mergePull}
            onArm={armPull}
            isArmed={isArmed}
          />
        </div>
        <Show when={chains().length === 0 && meta.repo === null && !sessionReady()}>
          <div class="mn-empty" />
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
    render: () => <MuninnSettings />,
  })
}

const MuninnSettings = (): JSX.Element => {
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
          <span class="mn-note" style={{ padding: "0 6px" }}>{ctx.t("settings.retention.days")}</span>
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
[data-muninn] {
  color: var(--v2-text-text-base);
  font-size: 12px;
  line-height: 1.45;
}
.mn-panel { height: 100%; min-height: 0; display: flex; flex-direction: column; }
.mn-scroll { min-height: 0; flex: 1; overflow-y: auto; padding: 10px 12px 14px; }
.mn-head { display: flex; align-items: center; gap: 6px; padding: 2px 4px 10px; color: var(--v2-text-text-muted); }
.mn-mark { color: var(--v2-icon-icon-muted); flex: none; display: inline-flex; }
.mn-repo { font-family: var(--v2-font-family-code); font-size: 11px; }
.mn-branch {
  margin-left: auto; font-size: 10.5px; font-family: var(--v2-font-family-code);
  color: var(--v2-text-text-faint); background: var(--v2-background-bg-layer-01);
  border-radius: 5px; padding: 2px 7px;
}
.mn-note { font-size: 10.5px; color: var(--v2-text-text-faint); padding: 0 4px 8px; }
.mn-note[data-warn] { color: var(--v2-state-fg-warning); }
.mn-day {
  font-size: 10px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase;
  color: var(--v2-text-text-faint); padding: 10px 4px 6px;
}
.mn-chain {
  background: var(--v2-background-bg-deep);
  border-radius: 10px;
  box-shadow: inset 0 0 0 .5px var(--v2-border-border-muted);
  padding: 4px 0 2px;
  margin-bottom: 8px;
}
.mn-chain[data-tone="danger"] { box-shadow: inset 0 0 0 .5px var(--v2-state-border-danger); }
.mn-row { position: relative; display: flex; align-items: center; gap: 8px; padding: 6px 10px 6px 12px; border-radius: 7px; min-width: 0; }
.mn-row:hover { background: var(--v2-overlay-simple-overlay-hover); cursor: pointer; }
.mn-row.sub { padding-left: 26px; }
.mn-row.sub::before { content: ""; position: absolute; left: 22px; top: -4px; height: 8px; width: 1px; background: var(--v2-border-border-strong); }
.mn-kind { flex: none; display: inline-flex; }
.mn-kind[data-state="issue-open"], .mn-kind[data-state="pr-open"] { color: var(--v2-state-fg-success); }
.mn-kind[data-state="pr-draft"] { color: var(--v2-icon-icon-faint); }
.mn-kind[data-state="pr-merged"], .mn-kind[data-state="issue-closed"] { color: var(--v2-text-text-accent); }
.mn-kind[data-state="pr-closed"] { color: var(--v2-state-fg-danger); }
.mn-id { font-family: var(--v2-font-family-code); font-size: 11.5px; font-weight: 600; flex: none; cursor: copy; }
.mn-id.copied { color: var(--v2-state-fg-success); }
.mn-chain[data-stale="true"] { opacity: .55; }
.mn-title { flex: 1; min-width: 0; font-size: 12px; color: var(--v2-text-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mn-meta { flex: none; font-size: 10.5px; color: var(--v2-text-text-faint); font-family: var(--v2-font-family-code); }
.mn-state { display: inline-flex; align-items: center; gap: 4px; flex: none; font-size: 10.5px; font-family: var(--v2-font-family-code); }
.mn-state[data-state="open"], .mn-state[data-status="succeeded"] { color: var(--v2-state-fg-success); }
.mn-state[data-state="merged"], .mn-state[data-state="closed"], .mn-state[data-status="running"] { color: var(--v2-text-text-accent); }
.mn-state[data-state="closed"][data-issue] { color: var(--v2-text-text-accent); }
.mn-state[data-state="draft"], .mn-state[data-status="queued"], .mn-state[data-status="cancelled"] { color: var(--v2-text-text-faint); }
.mn-state[data-state="closed"] { color: var(--v2-state-fg-danger); }
.mn-checks { overflow: hidden; max-height: 0; transition: max-height .18s ease; }
.mn-checks.show { max-height: 260px; }
.mn-check { display: flex; align-items: center; gap: 7px; padding: 3px 10px 3px 42px; font-size: 11px; font-family: var(--v2-font-family-code); color: var(--v2-text-text-muted); }
.mn-check-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mn-check [data-status="succeeded"] { color: var(--v2-state-fg-success); }
.mn-check [data-status="failed"] { color: var(--v2-state-fg-danger); }
.mn-check [data-status="running"] { color: var(--v2-text-text-accent); }
.mn-check [data-status="queued"], .mn-check [data-status="cancelled"] { color: var(--v2-text-text-faint); }
.mn-chain-foot {
  display: flex; align-items: center; gap: 8px; padding: 5px 12px 6px;
  border-top: 1px solid var(--v2-border-border-muted); margin-top: 3px;
  font-size: 10.5px; color: var(--v2-text-text-faint);
}
.mn-foot-ago { margin-left: auto; }
.mn-empty { color: var(--v2-text-text-faint); font-size: 11px; padding: 6px 4px; }
.mn-debug {
  flex: none; padding: 6px 12px 0;
  font-family: var(--v2-font-family-code); font-size: 9.5px;
  color: var(--v2-text-text-faint);
  border-top: 1px dashed var(--v2-border-border-muted);
  user-select: text; cursor: pointer;
}
.mn-debug:hover { color: var(--v2-text-text-muted); }
.mn-spin {
  width: 11px; height: 11px; border-radius: 50%; flex: none;
  border: 1.5px solid var(--v2-border-border-strong); border-top-color: var(--v2-text-text-accent);
  animation: mn-rot .9s linear infinite;
}
@keyframes mn-rot { to { transform: rotate(360deg); } }

/* Pill dropdown (custom popover content; the host owns the popover chrome). */
.mn-pop { display: flex; flex-direction: column; gap: 2px; min-width: 300px; max-width: 380px; max-height: 440px; overflow-y: auto; }
.mn-pop-chain { display: flex; flex-direction: column; gap: 1px; }
.mn-pop-chain + .mn-pop-chain { margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--v2-border-border-muted); }
.mn-pop-row { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 7px; font-size: 12px; min-width: 0; }
.mn-pop-row:hover { background: var(--v2-overlay-simple-overlay-hover); cursor: pointer; }
.mn-pop-id { font-family: var(--v2-font-family-code); font-size: 11px; color: var(--v2-text-text-muted); flex: none; }
.mn-pop-title { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--v2-text-text-base); }
.mn-pop-more { padding: 4px 8px; font-size: 11px; color: var(--v2-text-text-faint); cursor: pointer; border-radius: 7px; }
.mn-pop-more:hover { background: var(--v2-overlay-simple-overlay-hover); color: var(--v2-text-text-muted); }
.mn-pop-foot {
  display: flex; align-items: center; gap: 12px;
  margin-top: 4px; padding: 7px 8px 3px;
  border-top: 1px solid var(--v2-border-border-muted);
  font-size: 11px; color: var(--v2-text-text-faint);
}
.mn-pop-toggle { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
.mn-pop-foot select {
  margin-left: auto; font-size: 11px; color: var(--v2-text-text-muted);
  background: var(--v2-background-bg-layer-01); border: 1px solid var(--v2-border-border-muted);
  border-radius: 5px; padding: 2px 6px;
}
.mn-kind { color: var(--v2-icon-icon-muted); flex: none; display: inline-flex; }
.mn-kind[data-state="open"], .mn-kind[data-state="succeeded"] { color: var(--v2-state-fg-success); }
.mn-kind[data-state="draft"], .mn-kind[data-state="queued"], .mn-kind[data-state="running"] { color: var(--v2-state-fg-warning); }
.mn-kind[data-state="merged"] { color: var(--v2-state-fg-success); }
.mn-kind[data-state="closed"], .mn-kind[data-state="failed"], .mn-kind[data-state="cancelled"] { color: var(--v2-state-fg-danger); }

/* Merge action: green when ready, amber while checks run, grey when blocked. */
.mn-merge {
  flex: none; font-size: 10.5px; font-weight: 600; line-height: 1;
  padding: 4px 9px; border-radius: 6px; cursor: pointer;
  color: var(--v2-state-fg-on-success, #fff);
  background: var(--v2-state-bg-success, #1a7f37); border: none;
}
.mn-merge:hover { filter: brightness(1.1); }
.mn-merge.pending { background: var(--v2-state-bg-warning, #9a6700); }
.mn-merge.armed {
  background: none; color: var(--v2-state-fg-warning, #9a6700);
  box-shadow: inset 0 0 0 .5px var(--v2-state-border-warning, #9a6700);
}
.mn-merge.armed:hover { background: var(--v2-overlay-simple-overlay-hover); filter: none; }

/* Merge-status glyph: GitHub's circle-dot, colored by merge state. */
.mn-merge-state { color: var(--v2-icon-icon-muted); flex: none; display: inline-flex; }
.mn-merge-state[data-state="ready"] { color: var(--v2-state-fg-success, #1a7f37); }
.mn-merge-state[data-state="pending"], .mn-merge-state[data-state="blocked"], .mn-merge-state[data-state="unknown"] { color: var(--v2-state-fg-warning, #9a6700); }
.mn-merge-state[data-state="conflict"] { color: var(--v2-state-fg-danger, #cf222e); }
`

let injected = false
const injectStyles = (): void => {
  if (injected || typeof document === "undefined") return
  const style = document.createElement("style")
  style.textContent = STYLES
  style.dataset.muninn = ""
  document.head.append(style)
  injected = true
}
