import { For, Match, Show, Switch, createSignal } from "solid-js"
import type { Accessor, JSX } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import type { Chain, PullEntity, RepoRef, RunEntity, RunStatus } from "../model"
import { chainTone, mergeFailed, mergeReady, mergeWhy, prConflicted } from "../model"
import type { definition } from "./definition"
import { Mark } from "./marks"
import { CancelledGlyph, CheckGlyph, CrossGlyph, IssueGlyph, MergeGlyph, MergedGlyph, PinGlyph, PullConflictGlyph, PullGlyph, QueuedGlyph, UnknownGlyph } from "./icons"
import { auditTitle, time } from "./audit-title"

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
  /** Whether this chain is the pinned pill. */
  isPinned: (chain: Chain) => boolean
  /** Toggles the pin leading the pills for a chain (single pin; re-pin moves it). */
  onPin: (chain: Chain) => void
  waitForAllStatusChecks: Accessor<boolean>
}

/**
 * The PR action button, shared by the sidebar and the pill's dropdown — GitHub's
 * states: green "Merge" when it can merge now; red disabled "Merge when ready"
 * when checks failed, changes were requested, or the branch conflicts/is
 * blocked (fix it first — it can't be armed); amber "Merge when ready" while
 * something is still running or unavailable; a state-tinted "Merging when ready"
 * once watched (green = merging next check, red = blocked, amber = still
 * waiting — click stops it). Nothing renders for merged/closed PRs.
 */
export const MergeButton = (props: {
  chain: Chain
  pull: PullEntity
  waitForAllStatusChecks: () => boolean
  isArmed: (pull: PullEntity) => boolean
  onMerge: (pull: PullEntity) => Promise<void>
  onArm: (pull: PullEntity, enable: boolean) => Promise<void>
}): JSX.Element => {
  const wait = () => props.waitForAllStatusChecks()
  /** Watching tints follow the live PR state; the node itself stays stable so
   * refresh ticks never drop focus or restart the spinner. */
  const watchedReady = () => mergeReady(props.chain, props.pull, wait())
  const watchedFailed = () => !watchedReady() && mergeFailed(props.chain, props.pull, wait())
  const watchedClass = () => `mn-merge armed${watchedReady() ? " ready" : ""}${watchedFailed() ? " failed" : ""}`
  const watchedTitle = () => {
    const forge = props.pull.autoMerge ? ` (also on the forge as ${props.pull.autoMerge})` : ""
    const state = watchedReady()
      ? "ready — merging on the next check (within ~30s)"
      : `${mergeWhy(props.chain, props.pull, wait())} — will merge when green`
    return `Merging when ready${forge}: ${state}. Click to stop.`
  }
  const failedTitle = () => `${mergeWhy(props.chain, props.pull, wait())} — fix this before it can merge`
  return (
  <Show when={props.pull.state === "open"}>
    <Switch>
      <Match when={props.isArmed(props.pull)}>
        <button
          class={watchedClass()}
          title={watchedTitle()}
          onClick={(event) => {
            event.stopPropagation()
            void props.onArm(props.pull, false)
          }}
        >
          <span class="mn-spin" />
          Merging when ready
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
      <Match when={props.pull.state === "open" && mergeFailed(props.chain, props.pull, props.waitForAllStatusChecks())}>
        <span
          class="mn-wrap-fail"
          title={failedTitle()}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            class="mn-merge failed"
            disabled
            title={failedTitle()}
          >
            Merge when ready
          </button>
        </span>
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
}

/**
 * The chain pin: the pin octicon riding at the far right of the chain's title
 * row. The row title truncates (ellipsis) to clear room for it. Unpinned pins
 * take no space until their row is hovered or focused, shifting the tail left
 * at that moment; the pinned one keeps its highlighted pin and slot so the
 * override stays discoverable.
 */
const PinButton = (props: { pinned: boolean; title: string; label: string; onPin: () => void }): JSX.Element => (
  <button
    class="mn-pin"
    type="button"
    data-pinned={props.pinned ? "true" : "false"}
    title={props.title}
    aria-label={props.label}
    aria-pressed={props.pinned}
    onClick={(event) => {
      event.stopPropagation()
      props.onPin()
    }}
  >
    <PinGlyph solid={props.pinned} />
  </button>
)

const dayLabel = (epoch: number): string => new Date(epoch).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })

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
                  {(pull, prIndex) => {
                    // Per-PR evidence: a non-lead row must never show the lead's
                    // audit. Closed PRs have no merge icon, so the tooltip target
                    // renders exactly when this PR carries ledger evidence.
                    // A getter, not a snapshot: ledger writes must refresh
                    // tooltips and reveal closed-PR icons without a rechain.
                    const audit = () => auditTitle(ctx.stores.activity.value.entries, pull)
                    return (
                    <div
                      class="mn-row"
                      classList={{ sub: prIndex() > 0 }}
                      onClick={() => props.onOpen(pull.url)}
                    >
                      <span class="mn-mark">
                        <Mark provider={pull.provider} />
                      </span>
                      <span
                        class="mn-kind"
                        data-state={prConflicted(pull) ? "pr-conflict" : `pr-${pull.state}`}
                        title={ctx.t(prConflicted(pull) ? "state.pr-conflict" : `state.${pull.state}`)}
                      >
                        {pull.state === "merged" ? <MergedGlyph /> : prConflicted(pull) ? <PullConflictGlyph /> : <PullGlyph />}
                      </span>
                      <Show when={pull.state === "open" || pull.state === "merged" || audit() !== undefined}>
                        <span
                          class="mn-merge-state"
                          data-state={pull.state === "merged" ? "merged" : pull.mergeState ?? "unknown"}
                          data-armed={props.isArmed(pull) ? "" : undefined}
                          title={
                            audit() ??
                            `merge: ${pull.state === "merged" ? "merged" : pull.mergeState ?? "unknown"}${pull.reviewState ? ` · reviews: ${pull.reviewState}` : ""}${props.isArmed(pull) ? " · Muninn is watching" : ""}`
                          }
                        >
                          {pull.state === "open" && pull.mergeState == null ? <UnknownGlyph /> : <MergeGlyph />}
                        </span>
                      </Show>
                      <span
                        class="mn-id"
                        classList={{ copied: copied() === `p${chain.key}${pull.number}` }}
                        title="Click to copy PR URL"
                        onClick={(event) => copyId(event, pull.url, `p${chain.key}${pull.number}`)}
                      >
                        {copied() === `p${chain.key}${pull.number}` ? "✓" : `#${pull.number}`}
                      </span>
                      <span class="mn-title" title={pull.title || `#${pull.number}`}>{pull.title || `#${pull.number}`}</span>
                      <MergeButton chain={chain} pull={pull} isArmed={props.isArmed} waitForAllStatusChecks={props.waitForAllStatusChecks} onMerge={props.onMerge} onArm={props.onArm} />
                      <Show when={prIndex() === 0}>
                        <PinButton
                          pinned={props.isPinned(chain)}
                          title={ctx.t(props.isPinned(chain) ? "chain.unpin" : "chain.pin")}
                          label={ctx.t(props.isPinned(chain) ? "chain.unpin" : "chain.pin")}
                          onPin={() => props.onPin(chain)}
                        />
                      </Show>
                    </div>
                    )
                  }}
                </For>

                <For each={chain.issues}>
                  {(issue, issueIndex) => (
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
                      <span class="mn-title" title={issue.title || `#${issue.number}`}>{issue.title || `#${issue.number}`}</span>
                      <Show when={chain.prs.length === 0 && issueIndex() === 0}>
                        <PinButton
                          pinned={props.isPinned(chain)}
                          title={ctx.t(props.isPinned(chain) ? "chain.unpin" : "chain.pin")}
                          label={ctx.t(props.isPinned(chain) ? "chain.unpin" : "chain.pin")}
                          onPin={() => props.onPin(chain)}
                        />
                      </Show>
                    </div>
                  )}
                </For>

                <For each={chain.runs}>
                  {(run, runIndex) => (
                    <RunRow
                      run={run}
                      chainKey={chain.key}
                      expanded={expanded}
                      onToggle={toggle}
                      onOpen={props.onOpen}
                      label={ctx.t}
                      showPin={chain.prs.length === 0 && chain.issues.length === 0 && runIndex() === 0}
                      pinned={props.isPinned(chain)}
                      pinTitle={ctx.t(props.isPinned(chain) ? "chain.unpin" : "chain.pin")}
                      onPin={() => props.onPin(chain)}
                    />
                  )}
                </For>

                <Show when={chain.prs.length > 0 && chain.issues.length > 0}>
                  <div class="mn-chain-foot">
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
  showPin: boolean
  pinned: boolean
  pinTitle: string
  onPin: () => void
}): JSX.Element => {
  const key = () => `${props.chainKey}#${props.run.id}`
  // Test workflows often report an empty workflow name: fall back to the run
  // id so the row is never unlabeled. The tooltip keeps both halves.
  const displayName = (): string => props.run.name || `run #${props.run.id}`
  const fullTitle = (): string => props.run.name ? `${props.run.name} (run #${props.run.id})` : `run #${props.run.id}`

  return (
    <>
      <div class="mn-row sub" onClick={() => props.onToggle(key())}>
        <span class="mn-state" data-status={props.run.status} title={props.label(`state.${props.run.status}`)}>
          <StatusGlyph status={props.run.status} />
        </span>
        <span class="mn-title" title={fullTitle()}>
          {displayName()}
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
        <Show when={props.showPin}>
          <PinButton pinned={props.pinned} title={props.pinTitle} label={props.pinTitle} onPin={props.onPin} />
        </Show>
      </div>
      <div class="mn-checks" classList={{ show: props.expanded().has(key()) }}>
        <For each={props.run.checks}>
          {(check) => (
            <div class="mn-check">
              <span data-status={check.status} title={props.label(`state.${check.status}`)}>
                <StatusGlyph status={check.status} />
              </span>
              <span class="mn-check-name" title={check.name}>{check.name}</span>
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
