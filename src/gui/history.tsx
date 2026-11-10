import { For, Match, Show, Switch, createSignal } from "solid-js"
import type { Accessor, JSX } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import type { Chain, PullEntity, RepoRef, RunEntity, RunStatus } from "../model"
import { chainTone, mergeReady, mergeWhy, repoKey } from "../model"
import type { definition } from "./definition"
import { Mark } from "./marks"
import { CancelledGlyph, CheckGlyph, CrossGlyph, IssueGlyph, MergeGlyph, MergedGlyph, PullGlyph, QueuedGlyph } from "./icons"

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
  sessionReady: Accessor<boolean>
  onOpen: (url: string) => void
  /** Merges the pull request now (method + delete-branch from settings, head-SHA guarded). */
  onMerge: (pull: PullEntity) => Promise<void>
  /** Arms or disarms merge-when-ready (Muninn drives the merge when green). */
  onArm: (pull: PullEntity, enable: boolean) => Promise<void>
  /** Whether the PR is armed — locally by Muninn, or already on the forge. */
  isArmed: (pull: PullEntity) => boolean
  waitForAllStatusChecks: Accessor<boolean>
}

/**
 * The PR action button, shared by the sidebar and the pill's dropdown — GitHub's
 * three states: green "Merge" when it can merge now; amber "Merge when ready"
 * arming auto-merge when something blocks it; an amber "Armed" cancelling it when
 * auto-merge is on. Nothing renders for merged/closed PRs.
 */
export const MergeButton = (props: {
  chain: Chain
  pull: PullEntity
  waitForAllStatusChecks: () => boolean
  isArmed: (pull: PullEntity) => boolean
  onMerge: (pull: PullEntity) => Promise<void>
  onArm: (pull: PullEntity, enable: boolean) => Promise<void>
}): JSX.Element => (
  <Show when={props.pull.state === "open"}>
    <Switch>
      <Match when={props.isArmed(props.pull)}>
        <button
          class="mn-merge armed"
          title={
            props.pull.autoMerge
              ? `armed here and on the forge (${props.pull.autoMerge}) — Muninn merges when checks pass and reviews approve. Click to cancel.`
              : "Muninn is watching — it merges the moment checks pass and reviews approve. Click to cancel."
          }
          onClick={(event) => {
            event.stopPropagation()
            void props.onArm(props.pull, false)
          }}
        >
          <span class="mn-spin" />
          Armed
        </button>
      </Match>
      <Match when={mergeReady(props.chain, props.pull, props.waitForAllStatusChecks())}>
        <button
          class="mn-merge"
          title="Merge now — method and delete-branch follow the pill menu's choices"
          onClick={(event) => {
            event.stopPropagation()
            void props.onMerge(props.pull)
          }}
        >
          Merge
        </button>
      </Match>
      <Match when={props.pull.state === "open"}>
        <button
          class="mn-merge pending"
          title={`${mergeWhy(props.chain, props.pull, props.waitForAllStatusChecks())} — click to merge when ready (auto-merge)`}
          onClick={(event) => {
            event.stopPropagation()
            void props.onArm(props.pull, true)
          }}
        >
          Merge when ready
        </button>
      </Match>
    </Switch>
  </Show>
)

/**
 * The evidence line under a chain's PR rows: what Muninn actually did to the lead
 * PR — merge, branch deletion, failures — straight from the activity ledger. A
 * merged PR with no ledger entry was merged on the forge, not by Muninn.
 */
const AuditLine = (props: { chain: Chain }): JSX.Element => {
  const ctx = usePlugin<typeof definition>()
  return (
    <Show when={props.chain.prs[0]}>
      {(lead) => {
        const match = (kind: "merged" | "branch-deleted" | "branch-delete-failed" | "merge-failed") =>
          ctx.stores.activity.value.entries.find(
            (entry) => entry.kind === kind && entry.number === lead().number && repoKey(entry.repo) === repoKey(lead().repo),
          )
        const merged = match("merged")
        const failed = match("merge-failed")
        const deleted = match("branch-deleted")
        const deleteFailed = match("branch-delete-failed")
        return (
          <Show when={merged || failed || lead().state === "merged"}>
            <div class="mn-audit">
              {merged ? (
                <span>
                  merged by Muninn ({merged.method ?? "squash"})
                  {merged.via === "when-ready" ? " · when ready" : ""} · {time(merged.at)}
                  {deleted ? " · branch deleted" : ""}
                  {deleteFailed ? " · branch deletion failed" : ""}
                </span>
              ) : failed ? (
                <span title={failed.detail}>merge failed · {time(failed.at)}</span>
              ) : (
                <span>merged on the forge — not by Muninn</span>
              )}
            </div>
          </Show>
        )
      }}
    </Show>
  )
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
    void ctx.system.copy(text).then(() => {
      setCopied(key)
      setTimeout(() => setCopied(null), 900)
    }).catch(() => undefined)
  }

  return (
    <div class="mn-root" data-muninn>
      <div class="mn-head">
        <span class="mn-mark">
          <Mark host={props.repo()?.host} />
        </span>
        <span class="mn-repo">{props.repo() ? `${props.repo()!.owner}/${props.repo()!.repo}` : ctx.t("repo.reading")}</span>
        <Show when={props.branch()}>
          <span class="mn-branch">{props.branch()}</span>
        </Show>
      </div>

      <Show when={props.repo() && !props.authenticated()}>
        <div class="mn-note">{ctx.t("auth.note")}</div>
        <Show when={props.unresolved() > 0}>
          <div class="mn-note" data-warn>{ctx.plural("auth.unresolved", props.unresolved())}</div>
        </Show>
      </Show>
      <Show when={props.error()}>
        <div class="mn-note" data-warn>
          {ctx.t("panel.error", { message: props.error() ?? "" })}{" "}
          <button
            class="mn-copy-link"
            type="button"
            title={ctx.t("panel.error.copy")}
            aria-label={ctx.t("panel.error.copy")}
            onClick={(event) => copyId(event, props.error() ?? "", "error")}
          >
            {copied() === "error" ? ctx.t("panel.error.copied") : ctx.t("panel.error.copy")}
          </button>
        </div>
      </Show>

      <Show
        when={props.chains().length > 0}
        fallback={
          <div class="mn-empty">
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
                <div class="mn-day">{dayLabel(chain.updatedAt)}</div>
              </Show>
              <div class="mn-chain" data-tone={chainTone(chain, props.waitForAllStatusChecks())}>
                <For each={chain.prs}>
                  {(pull, prIndex) => (
                    <div
                      class="mn-row"
                      classList={{ sub: prIndex() > 0 }}
                      onClick={() => props.onOpen(pull.url)}
                    >
                      <span class="mn-mark">
                        <Mark provider={pull.provider} />
                      </span>
                      <span class="mn-kind" data-state={`pr-${pull.state}`} title={ctx.t(`state.${pull.state}`)}>
                        <Show when={pull.state === "merged"} fallback={<PullGlyph />}>
                          <MergedGlyph />
                        </Show>
                      </span>
                      <Show when={pull.state === "open"}>
                        <span
                          class="mn-merge-state"
                          data-state={pull.mergeState ?? "unknown"}
                          data-armed={props.isArmed(pull) ? "" : undefined}
                          title={`merge: ${pull.mergeState ?? "unknown"}${pull.reviewState ? ` · reviews: ${pull.reviewState}` : ""}${props.isArmed(pull) ? " · Muninn is watching" : ""}`}
                        >
                          <MergeGlyph />
                        </span>
                      </Show>
                      <span
                        class="mn-id"
                        classList={{ copied: copied() === `p${chain.key}${pull.number}` }}
                        title="Click to copy"
                        onClick={(event) => copyId(event, `#${pull.number}`, `p${chain.key}${pull.number}`)}
                      >
                        {copied() === `p${chain.key}${pull.number}` ? "✓" : `#${pull.number}`}
                      </span>
                      <span class="mn-title">{pull.title}</span>
                      <MergeButton chain={chain} pull={pull} isArmed={props.isArmed} waitForAllStatusChecks={props.waitForAllStatusChecks} onMerge={props.onMerge} onArm={props.onArm} />
                    </div>
                  )}
                </For>

                <For each={chain.issues}>
                  {(issue) => (
                    <div class="mn-row sub" onClick={() => props.onOpen(issue.url)}>
                      <span class="mn-mark">
                        <Mark provider={issue.provider} />
                      </span>
                      <span class="mn-kind" data-state={`issue-${issue.state}`} title={ctx.t(`state.${issue.state}`)}>
                        <IssueGlyph closed={issue.state === "closed"} />
                      </span>
                      <span
                        class="mn-id"
                        classList={{ copied: copied() === `i${chain.key}${issue.number}` }}
                        title="Click to copy"
                        onClick={(event) => copyId(event, `#${issue.number}`, `i${chain.key}${issue.number}`)}
                      >
                        {copied() === `i${chain.key}${issue.number}` ? "✓" : `#${issue.number}`}
                      </span>
                      <span class="mn-title">{issue.title}</span>
                    </div>
                  )}
                </For>

                <For each={chain.runs}>
                  {(run) => (
                    <RunRow run={run} chainKey={chain.key} expanded={expanded} onToggle={toggle} onOpen={props.onOpen} label={ctx.t} />
                  )}
                </For>

                <Show when={chain.prs.length > 0 && chain.issues.length > 0}>
                  <div class="mn-chain-foot">
                    <span>
                      Closes {chain.issues.map((issue) => `#${issue.number}`).join(", ")}
                    </span>
                  </div>
                </Show>
                <AuditLine chain={chain} />
              </div>
            </>
          )}
        </For>
      </Show>
      <Show when={props.showDebug()}>
        <div
          class="mn-debug"
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
      <div class="mn-row sub" onClick={() => props.onToggle(key())}>
        <span class="mn-state" data-status={props.run.status} title={props.label(`state.${props.run.status}`)}>
          <StatusGlyph status={props.run.status} />
        </span>
        <span class="mn-title" title={`run ${props.run.id}`}>
          {props.run.name}
        </span>
        <span class="mn-meta">{time(props.run.updatedAt)}</span>
        <span
          class="mn-link"
          title="Open run"
          onClick={(event) => {
            event.stopPropagation()
            props.onOpen(props.run.url)
          }}
        >
          ↗
        </span>
      </div>
      <div class="mn-checks" classList={{ show: props.expanded().has(key()) }}>
        <For each={props.run.checks}>
          {(check) => (
            <div class="mn-check">
              <span data-status={check.status} title={props.label(`state.${check.status}`)}>
                <StatusGlyph status={check.status} />
              </span>
              <span class="mn-check-name">{check.name}</span>
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
  if (props.status === "running") return <span class="mn-spin" />
  return <QueuedGlyph />
}
