import { For, Show, createSignal } from "solid-js"
import type { Accessor, JSX } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import type { Chain, RepoRef, RunEntity, RunStatus } from "../model"
import type { PullEntity } from "../model"
import { chainTone } from "../model"
import type { definition } from "./definition"
import { Mark } from "./marks"
import { CancelledGlyph, CheckGlyph, CrossGlyph, IssueGlyph, MergedGlyph, PullGlyph, QueuedGlyph } from "./icons"

const DAY_MS = 24 * 60 * 60 * 1000

export interface HistoryProps {
  chains: Accessor<readonly Chain[]>
  repo: Accessor<RepoRef | null>
  branch: Accessor<string>
  authenticated: Accessor<boolean>
  /** References that were extracted but could not be read (private repo without a credential). */
  unresolved: Accessor<number>
  /** The last refresh failure, shown so hydration problems are never silent. */
  error: Accessor<string | null>
  /** Build + pill-gate diagnostics, rendered as the panel footer when debug mode is on. */
  debug: Accessor<string>
  showDebug: Accessor<boolean>
  /** Whether the chain's lead PR is mergeable now (open, checks green, no blockers). */
  mergeReady: (chain: Chain) => boolean
  /** Why the lead PR can't merge yet — shown on the disabled button. */
  mergeWhy: (chain: Chain) => string
  sessionReady: Accessor<boolean>
  onOpen: (url: string) => void
  /** Merges the pull request (squash, head-SHA guarded) and refreshes. */
  onMerge: (pull: PullEntity) => Promise<void>
}

const dayLabel = (epoch: number): string => new Date(epoch).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })
const time = (epoch: number): string =>
  new Date(epoch).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })

const sameDay = (a: number, b: number): boolean => new Date(a).toDateString() === new Date(b).toDateString()

/**
 * The panel body: the session's chains as triplet cards under day headers, newest
 * activity first. State is carried by the colored kind/status glyphs; hover titles
 * spell it out. Ids copy on click.
 */
export const History = (props: HistoryProps) => {
  const ctx = usePlugin<typeof definition>()
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  const [copied, setCopied] = createSignal<string | null>(null)

  const toggle = (key: string) => {
    const next = new Set(expanded())
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setExpanded(next)
  }

  const copyId = (event: MouseEvent, text: string, key: string) => {
    event.stopPropagation()
    void ctx.system.copy(text).catch(() => undefined)
    setCopied(key)
    setTimeout(() => setCopied(null), 900)
  }

  return (
    <div class="qm-root" data-quartermaster>
      <div class="qm-head">
        <span class="qm-mark">
          <Mark host={props.repo()?.host} />
        </span>
        <span class="qm-repo">{props.repo() ? `${props.repo()!.owner}/${props.repo()!.repo}` : ctx.t("repo.reading")}</span>
        <Show when={props.branch()}>
          <span class="qm-branch">{props.branch()}</span>
        </Show>
      </div>

      <Show when={props.repo() && !props.authenticated()}>
        <div class="qm-note">{ctx.t("auth.note")}</div>
        <Show when={props.unresolved() > 0}>
          <div class="qm-note" data-warn>{ctx.t("auth.unresolved", { count: props.unresolved() })}</div>
        </Show>
      </Show>
      <Show when={props.error()}>
        <div class="qm-note" data-warn>{ctx.t("panel.error", { message: props.error() ?? "" })}</div>
      </Show>

      <Show
        when={props.chains().length > 0}
        fallback={
          <div class="qm-empty">
            <Show when={props.repo()} fallback={props.sessionReady() ? ctx.t("repo.none") : ctx.t("repo.reading")}>
              <b>{ctx.t("empty.title")}</b>
              <br />
              {ctx.t("empty.body")}
            </Show>
          </div>
        }
      >
        <For each={props.chains()}>
          {(chain, index) => (
            <>
              <Show when={index() === 0 || !sameDay(props.chains()[index() - 1]!.updatedAt, chain.updatedAt)}>
                <div class="qm-day">{dayLabel(chain.updatedAt)}</div>
              </Show>
              <div class="qm-chain" data-tone={chainTone(chain)}>
                <For each={chain.prs}>
                  {(pull, prIndex) => (
                    <div
                      class="qm-row"
                      classList={{ sub: prIndex() > 0 }}
                      onClick={() => props.onOpen(pull.url)}
                    >
                      <span class="qm-mark">
                        <Mark provider={pull.provider} />
                      </span>
                      <span class="qm-kind" data-state={`pr-${pull.state}`} title={ctx.t(`state.${pull.state}`)}>
                        <Show when={pull.state === "merged"} fallback={<PullGlyph />}>
                          <MergedGlyph />
                        </Show>
                      </span>
                      <span
                        class="qm-id"
                        classList={{ copied: copied() === `p${chain.key}${pull.number}` }}
                        title="Click to copy"
                        onClick={(event) => copyId(event, `#${pull.number}`, `p${chain.key}${pull.number}`)}
                      >
                        {copied() === `p${chain.key}${pull.number}` ? "✓" : `#${pull.number}`}
                      </span>
                      <span class="qm-title">{pull.title}</span>
                      <Show when={pull.state === "open"}>
                        <button
                          class="qm-merge"
                          classList={{ pending: !props.mergeReady(chain) }}
                          disabled={!props.mergeReady(chain)}
                          title={props.mergeReady(chain) ? "Merge (squash)" : props.mergeWhy(chain)}
                          onClick={(event) => {
                            event.stopPropagation()
                            void props.onMerge(pull)
                          }}
                        >
                          Merge
                        </button>
                      </Show>
                      <Show when={pull.state === "open"}>
                        <button
                          class="qm-merge"
                          title={props.mergeReady(chain) ? "Merge (squash)" : props.mergeWhy(chain) ?? "not ready"}
                          disabled={!props.mergeReady(chain)}
                          onClick={(event) => {
                            event.stopPropagation()
                            void props.onMerge(pull)
                          }}
                        >
                          Merge
                        </button>
                      </Show>
                    </div>
                  )}
                </For>

                <For each={chain.issues}>
                  {(issue) => (
                    <div class="qm-row sub" onClick={() => props.onOpen(issue.url)}>
                      <span class="qm-mark">
                        <Mark provider={issue.provider} />
                      </span>
                      <span class="qm-kind" data-state={`issue-${issue.state}`} title={ctx.t(`state.${issue.state}`)}>
                        <IssueGlyph closed={issue.state === "closed"} />
                      </span>
                      <span
                        class="qm-id"
                        classList={{ copied: copied() === `i${chain.key}${issue.number}` }}
                        title="Click to copy"
                        onClick={(event) => copyId(event, `#${issue.number}`, `i${chain.key}${issue.number}`)}
                      >
                        {copied() === `i${chain.key}${issue.number}` ? "✓" : `#${issue.number}`}
                      </span>
                      <span class="qm-title">{issue.title}</span>
                    </div>
                  )}
                </For>

                <For each={chain.runs}>
                  {(run) => (
                    <RunRow run={run} chainKey={chain.key} expanded={expanded} onToggle={toggle} onOpen={props.onOpen} label={ctx.t} />
                  )}
                </For>

                <Show when={chain.prs.length > 0 && chain.issues.length > 0}>
                  <div class="qm-chain-foot">
                    <span>
                      Closes {chain.issues.map((issue) => `#${issue.number}`).join(", ")}
                    </span>
                  </div>
                </Show>
              </div>
            </>
          )}
        </For>
      </Show>
      <Show when={props.showDebug()}>
        <div
          class="qm-debug"
          title="Click to copy diagnostics"
          onClick={() => void ctx.system.copy(props.debug()).catch(() => undefined)}
        >
          {props.debug()} · click to copy
        </div>
      </Show>
    </div>
  )
}

const RunRow = (props: {
  run: RunEntity
  chainKey: string
  expanded: Accessor<ReadonlySet<string>>
  onToggle: (key: string) => void
  onOpen: (url: string) => void
  label: (key: string) => string
}): JSX.Element => {
  const key = () => `${props.chainKey}#${props.run.id}`

  return (
    <>
      <div class="qm-row sub" onClick={() => props.onToggle(key())}>
        <span class="qm-state" data-status={props.run.status} title={props.label(`state.${props.run.status}`)}>
          <StatusGlyph status={props.run.status} />
        </span>
        <span class="qm-title" title={`run ${props.run.id}`}>
          {props.run.name}
        </span>
        <span class="qm-meta">{time(props.run.updatedAt)}</span>
        <span
          class="qm-link"
          title="Open run"
          onClick={(event) => {
            event.stopPropagation()
            props.onOpen(props.run.url)
          }}
        >
          ↗
        </span>
      </div>
      <div class="qm-checks" classList={{ show: props.expanded().has(key()) }}>
        <For each={props.run.checks}>
          {(check) => (
            <div class="qm-check">
              <span data-status={check.status} title={props.label(`state.${check.status}`)}>
                <StatusGlyph status={check.status} />
              </span>
              <span class="qm-check-name">{check.name}</span>
            </div>
          )}
        </For>
      </div>
    </>
  )
}

const StatusGlyph = (props: { status: RunStatus }): JSX.Element => {
  if (props.status === "succeeded") return <CheckGlyph />
  if (props.status === "failed") return <CrossGlyph />
  if (props.status === "cancelled") return <CancelledGlyph />
  if (props.status === "running") return <span class="qm-spin" />
  return <QueuedGlyph />
}
