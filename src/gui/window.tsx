import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { ComposerPill, Panel, createKeyed, type Plugin } from "@opencode/plugin/gui"
import { associate } from "../associate"
import { scan, textToScan } from "../extract"
import type { Chain, Entity, RepoRef, RunEntity } from "../model"
import { chainTone, repoKey } from "../model"
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
  })
  const [entities, setEntities] = createStore<Record<string, Entity>>({})
  const [runs, setRuns] = createStore<Record<string, readonly RunEntity[]>>({})
  const [chains, setChains] = createSignal<readonly Chain[]>([])
  const [sessionReady, setSessionReady] = createSignal(false)

  const session = () => ctx.sessions.current()

  /** All text Quartermaster may scan, from the mounted session's messages. */
  const text = () => {
    const current = session()
    if (!current) return ""
    const messages: readonly unknown[] = current.server.data.session.message.list(current.id)
    return messages.map((message) => textToScan((message as { parts?: unknown[] }).parts ?? [])).join("\n")
  }

  const refs = createMemo(() => (meta.repo ? scan(text(), meta.repo, [githubLexicon]) : []))

  const rechain = () => {
    const repo = meta.repo
    setChains(associate(Object.values(entities), repo ? (runs[repoKey(repo)] ?? []) : []))
  }

  const open = (url: string) => ctx.system.openExternal(url)

  /** Re-reads repository coordinates, then hydrates and re-chains. Cheap when cached. */
  const refresh = async () => {
    const current = session()
    if (!current) return
    setSessionReady(true)
    const client = ctx.client

    const info = await client.rpc(Quartermaster).repo({ directory: current.directory })
    setMeta({
      sessionID: current.id,
      repo: info.repo,
      provider: info.provider,
      authenticated: info.authenticated,
      branch: "",
    })
    if (!info.repo) return

    const vcs = await client.vcs.get({ location: { directory: current.directory } }).catch(() => undefined)
    const branch = vcs?.data?.branch?.current
    setMeta("branch", branch ?? "")

    const found = refs()
    if (found.length > 0) {
      const { entities: hydrated } = await client.rpc(Quartermaster).hydrate({ directory: current.directory, refs: found })
      setEntities((previous) => {
        const next = { ...previous }
        for (const entity of hydrated) next[entityKey(entity)] = entity
        return next
      })
    }
    if (branch) {
      const { runs: branchRuns } = await client.rpc(Quartermaster).branchRuns({ directory: current.directory, branch })
      setRuns(repoKey(info.repo), branchRuns)
    }
    rechain()
  }

  // Session (or its directory) changed: re-read everything.
  createKeyed(
    () => `${session()?.key ?? ""}\n${session()?.directory ?? ""}`,
    () => {
      setEntities({})
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
        .then(({ entities: hydrated }) => {
          setEntities((previous) => {
            const next = { ...previous }
            for (const entity of hydrated) next[entityKey(entity)] = entity
            return next
          })
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
  ctx.add(ComposerPill, {
    id: "links",
    order: 10,
    show: (input) => {
      if (input.session.id !== meta.sessionID) return undefined
      const list = chains().filter((chain) => chain.pr || chain.issue)
      if (list.length === 0) return undefined

      const worst = list.find((chain) => chainTone(chain) === "danger") ?? list[0]!
      const primary = worst.pr ?? worst.issue!
      const tone = chainTone(worst)
      const failed = worst.runs.find((run) => run.status === "failed")

      return {
        icon: pillIcon(meta.provider),
        label: `#${primary.number} ${failed ? ctx.t("state.failed") : ctx.t(`state.${worst.pr ? worst.pr.state : worst.issue!.state}`)}`,
        tone,
        title: ctx.t("pill.title"),
        rows: list.slice(0, 5).map((chain) => {
          const entity = chain.pr ?? chain.issue!
          const run = chain.runs[0]
          return {
            id: chain.key,
            label: `#${entity.number} ${entity.title}`,
            icon:
              run?.status === "failed"
                ? "circle-xmark"
                : run?.status === "running"
                  ? "outline-rotate-clockwise"
                  : run?.status === "succeeded"
                    ? "check"
                    : pillIcon(meta.provider),
            tone: chainTone(chain),
            detail: chain.pr ? chain.pr.headBranch : undefined,
            run: () => open(entity.url),
          }
        }),
      }
    },
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
            sessionReady={sessionReady}
            onOpen={open}
          />
        </div>
        <Show when={chains().length === 0 && meta.repo === null && !sessionReady()}>
          <div class="qm-empty" />
        </Show>
      </div>
    ),
  })
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
.qm-id { font-family: var(--v2-font-family-code); font-size: 11.5px; font-weight: 600; flex: none; }
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
