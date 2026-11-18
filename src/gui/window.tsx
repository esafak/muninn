import { createEffect, createMemo, createResource, createSignal, onCleanup, untrack, For, Show } from "solid-js"
import type { JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { ComposerPill, MenuItem, Panel, SettingsPage, createKeyed, usePlugin, type ComposerPillMenuProps, type IconName, type Plugin } from "@opencode/plugin/gui"
import { associate } from "../associate"
import { messageBuckets, WIRE_REF_CAP, wireRefs } from "../extract"
import type { TieredRef } from "../extract"
import {
  armedMergeEligible,
  commitDiscovery,
  createDiscoveryLedger,
  excludeCoveredRefs,
  freshKeyFor,
  freshKeysFor,
  isOperationCurrent,
  isRefreshCurrent,
  pollInterval,
  POLL_NORMAL_MS,
  partitionRefs,
  planDiscovery,
  releaseReservations,
  safetyRefs,
  shouldSettle,
  type DiscoveryLedger,
  type DiscoveryPlan,
  type FreshSafety,
} from "./hydration-policy"
import { heuristicExtract } from "../candidates/heuristic"
import { bareKindKept, bareSurvives } from "../candidates/filtering"
import {
  decisionProviderIds,
  decisionProviderLabel,
  DEFAULT_DECISION_PROVIDER_ID,
  defaultModelForProvider,
} from "../providers/decision-catalog"
import { CUSTOM_PROVIDER, mergeProviderOptions, resolveCustomCommit } from "./provider-options"
import { validateModelSyntax } from "../candidates/model-id"
import type { ArmedEntry, Chain, Entity, PillReason, Pin, PullEntity, RepoRef, RunEntity, RunStatus } from "../model"
import { chainTone, armedTargets, staleHeadRetryEligible, staleHeadEvidenceUsable, sessionAttemptCurrent, targetRefreshConfirmed, pillPick, pillDisplay, pillEligible, eligibilityProvenances, pillLeadOf, pinnedChain, pinForChain, rememberCreated, isFreshBaseSession, mergeReady, mergeWhy, pendingReviewNotice, latestRun, pullForRun, pullsForRun, prConflicted, refKey, repoKey, entityKey } from "../model"
import { mentionEvidence } from "../candidates/mention-evidence"
import { prCreateBranchLinks, prCreateRefs, validateCreateLinks } from "../candidates/created"
import { githubLexicon } from "../providers/github/lexicon"
import { baseCheckoutDecision, cleanFromCheck, cleanupDecision, cleanupResultMessage, cleanupSessionMatches, locateCheckout, safeFastForward, sessionMoveConfirmed, shouldFastForwardBase, shouldRecordCleanupFailure, worktreeOccupancyDecision } from "../local-cleanup"
import type { CheckoutKind } from "../local-cleanup"
import { Muninn } from "../rpc"
import type { definition } from "./definition"
import { History, MergeButton } from "./history"
import { CancelledGlyph, CheckGlyph, CopyGlyph, CrossGlyph, IssueGlyph, MergeGlyph, MergedGlyph, PullConflictGlyph, PullGlyph, QueuedGlyph, UnknownGlyph } from "./icons"
import { pillIcon } from "./marks"
import { applyDismissal, lastMenuIndex, mergedActionView, overflowCount, overflowLabel, pickableChains, pillViewForPick, type PillView } from "./pill-view"
import { pillPullDiagnostics } from "./pill-diagnostics"
import { refreshKeyFor, shouldClearActiveRefresh, shouldRunAutoRefresh } from "./refresh-guard"

/** Debounce for scan → hydrate while a message streams in. */
const HYDRATE_DEBOUNCE_MS = 600
/** How long a forge-reported merge blocks retries while hydration catches up.
 * Matches the server dedupe TTL: long enough to collapse double-fires across
 * windows, short enough that an open-after-merged (eventual consistency)
 * retries without a restart. */
const MERGE_CONFIRM_GRACE_MS = 60_000

/** Shared empty set for sessions with no created-PR memory yet: referential
 * stability keeps the pill memo from recomputing on every read. */
const EMPTY_CREATED: ReadonlySet<string> = new Set()

export const setup: Plugin.Setup<typeof definition> = (ctx) => {
  injectStyles()

  const [meta, setMeta] = createStore({
    sessionID: "",
    repo: null as RepoRef | null,
    provider: null as string | null,
    branch: "",
    headSha: null as string | null,
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
      for (const [key, stamped] of Object.entries(draft.at)) if (stamped < cutoff) { delete draft.entries[key]; delete draft.at[key] }
      for (const entity of hydrated) {
        draft.entries[entityKey(entity)] = entity
        draft.at[entityKey(entity)] = Date.now()
      }
    })
  }
  // Branch runs are durable too, keyed by repo+branch (the RPC is branch-scoped).
  const branchRunsKey = (repo: RepoRef, branch: string): string => `${repoKey(repo)}#${branch}`
  const cachedRuns = (): Record<string, readonly RunEntity[]> => {
    const entries = ctx.stores.branchRuns.value.entries as Record<string, readonly RunEntity[]>
    const { at } = ctx.stores.branchRuns.value
    const cutoff = Date.now() - retentionMs()
    const fresh: Record<string, readonly RunEntity[]> = {}
    for (const [key, runs] of Object.entries(entries)) if ((at[key] ?? Date.now()) > cutoff) fresh[key] = runs
    return fresh
  }
  const saveRuns = (repo: RepoRef, branch: string, runs: readonly RunEntity[]): void => {
    const key = branchRunsKey(repo, branch)
    ctx.stores.branchRuns.update((draft) => {
      const cutoff = Date.now() - retentionMs()
      for (const [stored, stamped] of Object.entries(draft.at)) if (stamped < cutoff) { delete draft.entries[stored]; delete draft.at[stored] }
      draft.entries[key] = runs.slice()
      draft.at[key] = Date.now()
    })
  }
  const [runs, setRuns] = createStore<Record<string, readonly RunEntity[]>>(cachedRuns())
  const [chains, setChains] = createSignal<readonly Chain[]>([])
  const [sessionReady, setSessionReady] = createSignal(false)
  /** Sticky memory of PRs each session owned (branch/SHA matched while live):
   * sequential multi-PR sessions keep every created PR pilled after moving to
   * the next branch, and navigating away and back never drops them. Keyed by
   * session identity + directory (the same key that reseeds the session);
   * oldest sessions evicted past the cap. Keys are repo-scoped entity keys. */
  const createdKeyFor = (): string => `${session()?.key ?? session()?.id ?? ""}\n${session()?.directory ?? ""}`
  const [createdBySession, setCreatedBySession] = createSignal<ReadonlyMap<string, ReadonlySet<string>>>(new Map())
  const createdKeys = (): ReadonlySet<string> => createdBySession().get(createdKeyFor()) ?? EMPTY_CREATED
  /** Chains removed from the composer row via unpin (pill popover or sidebar
   * share `togglePin`), keyed like created memory (session identity +
   * directory). Unpinning records the dismissal; pinning clears it, so the
   * sidebar pin re-adds the pill. */
  const [dismissedBySession, setDismissedBySession] = createSignal<ReadonlyMap<string, ReadonlySet<string>>>(new Map())
  const dismissedKeys = (): ReadonlySet<string> => dismissedBySession().get(createdKeyFor()) ?? EMPTY_CREATED
  /** Output-tier discovery ledgers, keyed like created memory (session identity
   * + directory). Plain Maps — ledger reads/writes never need reactivity, and
   * entries are scoped per session so navigating away can never poison another
   * session's backoff. Capped like created memory. */
  const discoveryLedgers = new Map<string, DiscoveryLedger>()
  const discoveryLedger = (): DiscoveryLedger => {
    const key = createdKeyFor()
    let ledger = discoveryLedgers.get(key)
    if (!ledger) {
      ledger = createDiscoveryLedger()
      discoveryLedgers.set(key, ledger)
      while (discoveryLedgers.size > 20) {
        const victim = [...discoveryLedgers.keys()].find((candidate) => candidate !== key)
        if (victim === undefined) break
        discoveryLedgers.delete(victim)
      }
    }
    return ledger
  }
  /** Distinct hydrate-operation sequence shared by refresh and the debounce:
   * concurrent executions must not share reservation ownership, and freshness
   * evidence is keyed by operation — never by the refresh generation both
   * pipelines can share. Monotonic: only increasing op ids publish. */
  let hydrateOp = 0
  /** Op id of the latest hydrate execution that sent requests (for the gate:
   * evidence is actionable only while no newer operation has started). */
  let lastSentOp = 0
  /** Freshness evidence for the latest accepted hydrate operation: kind-qualified
   * PR/run keys observed by that operation, for this session only. Armed-merge
   * driving requires membership here — a snapshot that merely matches the head
   * is not proof it was just observed. */
  let freshSafety: FreshSafety | undefined
  /** Publish accepted evidence once per completed operation. Monotonic: an older
   * completion racing a newer one never overwrites fresher evidence. */
  const publishFreshSafety = (op: number, keys: ReadonlySet<string>): void => {
    if (freshSafety !== undefined && op <= freshSafety.op) return
    freshSafety = { op, sessionKey: createdKeyFor(), keys }
  }
  const mergeInFlight = new Set<string>()
  const serverBusyUntil = new Map<string, number>()
  const rejectedHeadByPR = new Map<string, string>()
  const mergedAwaitingRefresh = new Map<string, number>()
  /** Still inside the post-merge confirm window; expired entries are dropped so
   * an open-after-merged retries instead of wedging until restart. */
  const mergeAwaiting = (key: string, now = Date.now()): boolean => {
    const at = mergedAwaitingRefresh.get(key)
    if (at === undefined) return false
    if (now - at >= MERGE_CONFIRM_GRACE_MS) {
      mergedAwaitingRefresh.delete(key)
      return false
    }
    return true
  }
  const refreshedPullByPR = new Map<string, PullEntity>()
  let refreshGeneration = 0
  /** Coalescing for automatic recovery refreshes: an identical auto refresh
   * already pending skips instead of overlapping (each start resets meta.repo,
   * so overlap can keep discovery permanently uncommitted). */
  let refreshActiveKey: string | undefined
  let refreshActiveGeneration = 0
  let branchRunsBranch: string | undefined
  let resumePendingBranch: string | undefined
  let resumeInFlightBranch: string | undefined
  /** Whether refresh completed a vcs branch read: distinguishes a completed
   * detached-HEAD (""/detached) from not-yet-loaded or mid-refresh (""). */
  let branchLoaded = false
  const mergeKey = (repo: RepoRef, number: number): string => `${repoKey(repo)}#${number}`
  const sameArm = (candidate: ArmedEntry, original: ArmedEntry): boolean =>
    mergeKey(candidate.repo, candidate.number) === mergeKey(original.repo, original.number) &&
    candidate.method === original.method &&
    candidate.armID === original.armID
  const removeArm = (original: ArmedEntry): void =>
    ctx.stores.armed.update((draft) => {
      draft.entries = draft.entries.filter((entry) => !sameArm(entry, original))
    })
  const removeArmsForPR = (repo: RepoRef, number: number): void =>
    ctx.stores.armed.update((draft) => {
      draft.entries = draft.entries.filter((entry) => mergeKey(entry.repo, entry.number) !== mergeKey(repo, number))
    })

  const session = () => ctx.sessions.current()

  /** The projected messages of the mounted session — the only text Muninn scans. */
  const messageList = () => {
    const current = session()
    return current ? current.server.data.session.message.list(current.id) : []
  }

  /** Provenance buckets: what the user typed vs what the agent's tools dragged
   * through, so incidental discoveries never become candidates. */
  const buckets = createMemo(() => messageBuckets(messageList()))

  /** Toggle for the one-shot decision-model judge; off keeps heuristic tier rules. */
  const decisionModelsEnabled = () => ctx.stores.settings.value.decisionModelsEnabled === true
  /** Model.Ref providerID: the stored value verbatim (or the default when
   * blank). Unknown IDs are never coerced here — they flow to resolveModel's
   * footer warning and fail-open judging. */
  const candidateProviderID = () => {
    const stored = ctx.stores.settings.value.candidateProviderID as string | undefined
    return stored?.trim() || DEFAULT_DECISION_PROVIDER_ID
  }
  const candidateModel = () => ctx.stores.settings.value.candidateModel

  /** One extraction: refs plus their evidence snippets. A single scan feeds
   * both the tiers and the judge — the two never diverge. */
  const extracted = createMemo(() =>
    heuristicExtract(buckets(), meta.repo ?? undefined, [githubLexicon], decisionModelsEnabled() ? "permissive" : "strict"),
  )
  const refs = () => extracted().refs

  /** Snippets for the DecisionModel: first bucket string (+command) per ref. */
  const snippets = () => extracted().snippets

  /**
   * Dedicated creation candidates: branch-linked `push && pr create`
   * compounds hydrate their PR for branch validation even when ordinary
   * extraction drops the output URL. Command-tier evidence (the invocation
   * names the branch); deduped against the base refs by entity key.
   */
  const creationRequests = (base: readonly TieredRef[]): TieredRef[] => {
    const have = new Set(base.map((ref) => refKey(ref)))
    const extra: TieredRef[] = []
    for (const link of prCreateBranchLinks(buckets(), [githubLexicon])) {
      const candidate: TieredRef = { repo: link.repo, number: link.number, kind: "pr", tier: "command" }
      const key = refKey(candidate)
      if (!have.has(key)) {
        have.add(key)
        extra.push(candidate)
      }
    }
    return extra
  }

  /**
   * Per-ref keep/drop verdicts, scoped to the session + directory + provider +
   * model that produced them. `undefined` (or a scope mismatch) means heuristic
   * keep-all: verdicts never leak across sessions, models, or provider switches.
   */
  interface JudgeVerdicts {
    sessionID: string
    directory: string
    providerID: string
    model?: string
    kept: Map<string, boolean>
  }
  const [verdicts, setVerdicts] = createSignal<JudgeVerdicts | undefined>(undefined)
  /**
   * Operation epoch: refresh and the message debounce share it, and the
   * LATEST pipeline to start wins. Captured before any await — a slow
   * refresh that started first must never overwrite a newer debounce
   * judgment, and a stale session's callbacks must never invalidate the
   * current session's pending judgment.
   */
  let judgeEpoch = 0
  // Stale verdicts never apply across toggle/provider switches. Track ONLY the
  // toggle/provider/model here: rechain() reads verdicts, so running it tracked
  // would make every committed judgment immediately wipe itself.
  createEffect(() => {
    decisionModelsEnabled()
    candidateProviderID()
    candidateModel()
    untrack(() => {
      setVerdicts(undefined)
      rechain()
    })
  })

  /** Verdicts only when they belong to this session, directory, toggle, provider, and model. */
  const verdictsForSession = (): Map<string, boolean> | undefined => {
    const v = verdicts()
    const current = session()
    if (!v || !current || v.sessionID !== current.id || v.directory !== current.directory) return undefined
    if (!decisionModelsEnabled()) return undefined
    if (v.providerID !== candidateProviderID()) return undefined
    if ((v.model ?? undefined) !== (candidateModel() ?? undefined)) return undefined
    return v.kept
  }

  /** Refs after the DecisionModel filter; toggle-off returns refs unchanged.
   * Bare-ref survival is judged over ACTUAL hydrated kinds (`bareSurvives`):
   * all-explicit-drops drops, anything unanswered fails open — so a sliced-off
   * kind can never silently kill its bare ref. */
  const filteredRefs = createMemo(() => {
    if (!decisionModelsEnabled()) return refs()
    const judged = verdictsForSession()
    if (!judged) return refs()
    return refs().filter((ref) => {
      if (ref.kind) return judged.get(refKey(ref)) !== false
      if (!ref.repo) return true
      const base = repoKey(ref.repo)
      const hydrated = (["issue", "pr", "run"] as const).filter(
        (kind) => entities[`${base}#${kind}${ref.number}`] !== undefined,
      )
      return bareSurvives(judged, base, ref.number, hydrated)
    })
  })

  const fresh = createMemo(() => isFreshBaseSession(meta.branch, refs().length))

  const rechain = () => {
    const repo = meta.repo
    // Chains are session-associated: only entities this session's transcript
    // references join, joined against the (global, durable) entity cache. Bare
    // references fan out to their hydrated kinds — but only kept kinds join:
    // a dropped kind is filtered here, not just at the ref level, so an
    // issue-keeps/PR-drops verdict can't smuggle the PR into its chain.
    // Runs pull in their pull requests (matched by head SHA), so the
    // association is visible without a mention.
    // When the DecisionModel judged, dropped refs never reach chains.
    const judged = verdictsForSession()
    // Branch runs are associated evidence too: a run the transcript never
    // mentioned still belongs to the PR whose head it tested. Those PRs are
    // pulled in below, not only for transcript runs.
    const sessionRuns = repo ? (runs[branchRunsKey(repo, meta.branch)] ?? []) : []
    const relevant = filteredRefs().flatMap((ref) => {
      if (ref.kind) {
        const entity = entities[refKey(ref)]
        return entity ? [entity] : []
      }
      if (!ref.repo) return []
      const base = repoKey(ref.repo)
      return (["issue", "pr", "run"] as const)
        .map((kind) => ({ kind, entity: entities[`${base}#${kind}${ref.number}`] as Entity | undefined }))
        .filter((entry): entry is { kind: "issue" | "pr" | "run"; entity: Entity } => entry.entity !== undefined)
        .filter(({ kind }) => bareKindKept(judged, base, ref.number, kind))
        .map(({ entity }) => entity)
    })
    const related: Entity[] = []
    // Explicit intent beats model verdicts: the pinned member joins even
    // when filtered out, so a drop can never hide the user's override.
    // Member identity (repo+number+kind) resolves run-series groups that
    // chain keys (JSON tuples) could never address.
    {
      const pin = ctx.stores.pinned.value
      const pinnedExtra: Entity[] = []
      if (pin.number !== undefined && pin.repo) {
        const peer = entities[`${repoKey(pin.repo)}#${pin.kind ?? "pr"}${pin.number}`]
        if (peer && !relevant.includes(peer)) pinnedExtra.push(peer)
      } else if (pin.key !== undefined) {
        const peer = (entities as Record<string, Entity | undefined>)[pin.key]
        if (peer && !relevant.includes(peer)) pinnedExtra.push(peer)
      }
      relevant.push(...pinnedExtra)
    }
    const runsToLink: RunEntity[] = [
      ...relevant.filter((entity): entity is RunEntity => entity.kind === "run"),
      ...sessionRuns,
    ]
    const cachedPulls = Object.values(entities).filter((entity): entity is PullEntity => entity.kind === "pr")
    for (const entity of runsToLink) {
      // Same rules associate() uses to bind runs: explicit PR ids, head SHA,
      // then unique head branch. Pulling the PR in lets a run that only came
      // from branchRuns (never mentioned in the transcript) join its chain.
      for (const candidate of pullsForRun(entity, cachedPulls)) {
        if (!relevant.includes(candidate) && !related.includes(candidate)) related.push(candidate)
      }
    }
    // Branch-linked creates hydrate through the dedicated path even when
    // ordinary extraction drops their URL: admit validated PRs so they
    // chain, and the owned block below seeds created-memory from the same
    // links. Validation (repo + number + headBranch, still open) runs
    // against hydrated entities, never against transcript prose.
    if (repo) {
      const links = prCreateBranchLinks(buckets(), [githubLexicon]).filter(
        (link) => repoKey(link.repo) === repoKey(repo),
      )
      if (links.length > 0) {
        const prs = Object.values(entities).filter(
          (entity): entity is PullEntity => entity.kind === "pr",
        )
        for (const key of validateCreateLinks(links, prs)) {
          const pull = entities[key]
          if (pull && !relevant.includes(pull) && !related.includes(pull)) related.push(pull)
        }
      }
    }
    if (isFreshBaseSession(meta.branch, refs().length)) {
      setChains([])
      return
    }
    const next = associate([...relevant, ...related], sessionRuns)
    setChains(next)
    // Remember PRs this session owns right now (branch/SHA match): the sticky
    // session-created set behind multi-pill sessions. Later branch switches
    // must not drop earlier created PRs from the pills. A detached-HEAD
    // `gh pr create --head` never matches branch/SHA, so its output URL also
    // seeds created-memory: creation evidence, not a mention.
    if (repo) {
      const owned: string[] = []
      for (const chain of next)
        for (const pull of chain.prs) {
          if (pull.state === "closed") continue
          if (repoKey(pull.repo) !== repoKey(repo)) continue
          if (
            (meta.branch !== "" && pull.headBranch === meta.branch) ||
            (meta.headSha !== null && pull.headSha === meta.headSha)
          )
            owned.push(entityKey(pull))
        }
      const createdViaCli = prCreateRefs(buckets(), [githubLexicon]).filter(
        (ref) => ref.repo && repoKey(ref.repo) === repoKey(repo),
      )
      if (createdViaCli.length > 0) {
        const createdViaCliKeys = new Set(
          createdViaCli.map((ref) => `${repoKey(ref.repo!)}#pr${ref.number}`),
        )
        for (const chain of next)
          for (const pull of chain.prs) {
            if (pull.state === "closed") continue
            if (repoKey(pull.repo) !== repoKey(repo)) continue
            if (createdViaCliKeys.has(entityKey(pull)) && !owned.includes(entityKey(pull)))
              owned.push(entityKey(pull))
          }
      }
      // Branch-linked compound creates (`git push … && gh pr create --head B`):
      // seed only after hydration confirms the PR's head branch equals `--head`
      // (same-repo; closed work drops out in the validator).
      const branchLinks = prCreateBranchLinks(buckets(), [githubLexicon]).filter(
        (link) => repoKey(link.repo) === repoKey(repo),
      )
      if (branchLinks.length > 0) {
        const linkKeys = validateCreateLinks(
          branchLinks,
          next.flatMap((chain) => chain.prs),
        )
        for (const key of linkKeys) if (!owned.includes(key)) owned.push(key)
      }
      if (owned.length > 0)
        setCreatedBySession((previous) => rememberCreated(previous, createdKeyFor(), owned))
    }
    // Expiry: a pin whose chain is gone unpins so a stale override can't stick
    // the pill — but only in the session that owns it (legacy ownerless pins
    // keep the same-repo rule). Another session's refresh must never erase it.
    const pin = ctx.stores.pinned.value
    const currentId = session()?.id
    const pinOwnedHere = (() => {
      if (pin.repo === undefined && pin.key === undefined) return false
      if (!repo) return false
      const sameRepo = pin.repo ? repoKey(pin.repo) === repoKey(repo) : pin.key!.startsWith(`${repoKey(repo)}#`)
      if (!sameRepo) return false
      return pin.owner === undefined || (currentId !== undefined && pin.owner === currentId)
    })()
    if (pinOwnedHere && !pinnedChain(chains(), pin))
      ctx.stores.pinned.update((draft) => {
        delete draft.repo
        delete draft.number
        delete draft.kind
        delete draft.key
        delete draft.owner
      })
  }

  const open = (url: string) => ctx.system.openExternal(url)

  /** Names the step that failed, in the panel message and the console: "the
   * forge is unreachable" is only ever one of several ways a refresh fails. */
  const stage = async <T,>(name: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (error) {
      console.warn(`[muninn] ${name} failed`, error)
      throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** One post-hydration policy: judge heuristic survivors with hydrated
   * titles/states, then rechain. Used by both refresh and the message
   * debounce so model filtering never depends on which path hydrated last.
   * - Refs are validated exactly like hydration input (`wireRefs`): an
   *   invalid number drops out instead of rejecting the whole batch.
   * - Only the latest call may commit (generation guard): overlapping calls
   *   from refresh and the debounce can't complete backwards.
   * - Verdicts are scoped to session + directory + toggle + provider + model; a
   *   response that arrives after any of those changed is discarded. RPC
   *   failure clears same-scope verdicts (fail-open keep-all) under the
   *   same guard instead of retaining stale drops. */
  const judgeFound = async (
    sessionID: string,
    directory: string,
    foundRefs: readonly TieredRef[],
    epoch: number,
  ): Promise<void> => {
    if (!decisionModelsEnabled() || foundRefs.length === 0) return
    const providerID = candidateProviderID()
    if (epoch !== judgeEpoch) return
    const judgedModel = candidateModel()
    const fresh = (): boolean => {
      const live = session()
      return epoch === judgeEpoch && !!live && live.id === sessionID && live.directory === directory &&
        decisionModelsEnabled() && candidateProviderID() === providerID && (candidateModel() ?? undefined) === (judgedModel ?? undefined)
    }
    try {
      // Validate like hydration: invalid numbers drop out instead of wedging
      // the whole judge call. The wire cap keeps the most deliberate tiers.
      const wire = wireRefs(foundRefs)
      // Bare refs fan out post-hydration: one JudgeInput per hydrated kind
      // (issue/PR/run title+state each), capped at 64 for the RPC schema.
      // Typed verdicts map back: bare stays iff any typed keeps.
      const candidates = wire.refs.flatMap((ref) => {
        const snippet = snippets().get(refKey(ref))
        const base = { tier: ref.tier, snippet: snippet?.text ?? "", ...(snippet?.command ? { command: snippet.command } : {}) }
        if (ref.kind) {
          const entity = entities[refKey(ref)]
          const title = entity === undefined ? undefined : entity.kind === "run" ? entity.name : entity.title
          const state = entity === undefined ? undefined : entity.kind === "run" ? entity.status : entity.state
          return [{
            number: ref.number, kind: ref.kind,
            ...(ref.repo ? { repo: ref.repo } : {}),
            ...base,
            ...(title ? { title } : {}),
            ...(state ? { state } : {}),
          }]
        }
        if (!ref.repo) return [{ number: ref.number, ...base }]
        const repoBase = repoKey(ref.repo)
        const hydrated = (["issue", "pr", "run"] as const)
          .map((kind) => ({ kind, entity: entities[`${repoBase}#${kind}${ref.number}`] as Entity | undefined }))
          .filter((entry): entry is { kind: "issue" | "pr" | "run"; entity: Entity } => entry.entity !== undefined)
        if (hydrated.length === 0) return [{ number: ref.number, ...(ref.repo ? { repo: ref.repo } : {}), ...base }]
        return hydrated.map(({ kind, entity }) => ({
          number: ref.number, kind,
          ...(ref.repo ? { repo: ref.repo } : {}),
          ...base,
          title: entity.kind === "run" ? entity.name : entity.title,
          state: entity.kind === "run" ? entity.status : entity.state,
        }))
      }).slice(0, 64)
      const judged = await ctx.client
        .rpc(Muninn)
        .judge({ directory, providerID, ...(judgedModel ? { model: judgedModel } : {}), candidates })
        .catch(() => undefined)
      // Commit or clear under the same freshness guard: a stale success must
      // not overwrite newer verdicts, and a failure must not retain stale drops.
      if (!fresh()) return
      if (judged)
        setVerdicts({ sessionID, directory, providerID, ...(judgedModel ? { model: judgedModel } : {}), kept: new Map(judged.verdicts.map((v) => [v.key, v.keep])) })
      else setVerdicts(undefined)
    } catch {
      if (fresh()) setVerdicts(undefined)
    }
  }

  /** Compact "#123, #456" for the stats line; repos outside the session's get a prefix. */
  const unresolvedLabel = (refs: readonly { number: number; repo?: RepoRef }[] | undefined, repo: RepoRef | undefined): string => {
    const labels = (refs ?? []).slice(0, 6).map((ref) =>
      ref.repo && repo && (ref.repo.owner !== repo.owner || ref.repo.repo !== repo.repo) ? `${ref.repo.owner}/${ref.repo.repo}#${ref.number}` : `#${ref.number}`,
    )
    const more = (refs?.length ?? 0) > 6 ? ` +${refs!.length - 6}` : ""
    return `${labels.join(", ")}${more}`
  }

  /** Re-reads repository coordinates, then hydrates and re-chains. Cheap when cached.
   * Explicit refreshes (session change, user actions) hydrate the full discovery
   * set; polls and targeted retries hydrate only new live refs plus due retries —
   * output-tier discovery otherwise stays frozen (see hydration-policy). */
  const refresh = async (input?: { target?: { repo: RepoRef; number: number }; full?: boolean }): Promise<boolean> => {
    const target = input?.target
    const full = input?.full ?? false
    const current = session()
    if (!current) return false
    const generation = ++refreshGeneration
    const key = refreshKeyFor(current.id, current.directory)
    refreshActiveKey = key
    refreshActiveGeneration = generation
    try {
    // Operation epoch shared with the message debounce: whichever pipeline
    // starts last owns the next judgment. Captured before any network I/O so
    // a slow refresh can never overwrite a newer debounce judgment.
    const epoch = ++judgeEpoch
    const currentRefresh = () =>
      isRefreshCurrent(sessionAttemptCurrent(current, session()), generation, refreshGeneration)
    const targetKey = target ? mergeKey(target.repo, target.number) : undefined
    if (targetKey) refreshedPullByPR.delete(targetKey)
    setSessionReady(true)
    // Gate pills on this session before any network: identity is known up front.
    branchLoaded = false
    setMeta((previous) => ({ ...previous, sessionID: current.id, repo: null, provider: null, branch: "", headSha: null }))
    const client = ctx.client

    const refreshed = await (async (): Promise<boolean> => {
      try {
        const info = await stage("repo", () => client.rpc(Muninn).repo({ directory: current.directory }))
        if (!currentRefresh()) return false
        const repo = info.repo
        setMeta({
          sessionID: current.id,
          repo: info.repo,
          provider: info.provider,
          authenticated: info.authenticated,
          branch: "",
          headSha: info.headSha,
        })
        if (!repo) {
          setMeta("error", null)
          return false
        }

        const vcs = await client.vcs.get({ location: { directory: current.directory } }).catch(() => undefined)
        const branch = vcs?.data?.branch?.current
        setMeta("branch", branch ?? "")
        branchLoaded = true

        const found = refs()
        const recoveryTargets = target
          ? [target]
          : ctx.stores.armed.value.entries.filter((entry) => rejectedHeadByPR.has(mergeKey(entry.repo, entry.number)))
        const recoveryKeys = new Set(recoveryTargets.map((entry) => mergeKey(entry.repo, entry.number)))
        for (const key of recoveryKeys) refreshedPullByPR.delete(key)
        const recoveredPulls = new Map<string, PullEntity>()
        const requestedBase: TieredRef[] = [
          ...found,
          ...recoveryTargets.map((entry) => ({
            repo: entry.repo,
            number: entry.number,
            kind: "pr" as const,
            tier: "user" as const,
          })),
        ]
        // Dedicated creation path: branch-linked `push && pr create`
        // compounds hydrate their PR for branch validation even when
        // ordinary extraction drops the output URL (listing, judge drop).
        // Creation evidence is not a mention, so this bypasses mention-drop
        // filtering by design; the URL still only seeds on a head-branch
        // match in rechain.
        const creation = creationRequests(requestedBase)
        const requested = [...requestedBase, ...creation]
        // One shared admission boundary (see admitHydration): safety always
        // rides along, discovery is budgeted, reservations are op-scoped.
        const creationRefs = creation
        const admission = admitHydration({
          requested,
          recovery: recoveryTargets,
          creation: creationRefs,
          ...(target ? { target: { repo: target.repo, number: target.number } } : {}),
          full,
          gen: generation,
          sessionRepo: repo,
        })
        const { sendList, batches, plan, ledger, opId, invalid: invalidDropped } = admission
        // Locally accumulated evidence for this operation only. Published once,
        // after every hydration stage below accepts it — branch results extend
        // the same set rather than overwriting hydrate's.
        const freshKeys = new Set<string>()
        let hydrateError: string | undefined
        let targetPull: PullEntity | undefined
        let targetUnresolved = false
        const allEntities: Entity[] = []
        const allUnresolved: { number: number; repo?: RepoRef }[] = []
        if (sendList.length > 0) {
          let results
          try {
            results = await stage("hydrate", () =>
              Promise.all(batches.map((refs) => client.rpc(Muninn).hydrate({ directory: current.directory, refs }))),
            )
          } catch (error) {
            releaseReservations(ledger, opId)
            throw error
          }
          for (const result of results) hydrateError ??= result.error
          const completed = settleHydration({
            admission,
            results,
            sessionRepo: repo,
            isCurrent: currentRefresh,
            latestOp: lastSentOp,
            onStale: () => {
              resumeInFlightBranch = undefined
            },
          })
          if (!completed) return false
          allEntities.push(...completed.entities)
          allUnresolved.push(...completed.unresolved)
          for (const key of freshKeysFor(allEntities)) freshKeys.add(key)
          merge(allEntities)
          for (const pull of allEntities.filter((entity): entity is PullEntity => entity.kind === "pr")) {
            const key = mergeKey(pull.repo, pull.number)
            if (recoveryKeys.has(key)) recoveredPulls.set(key, pull)
          }
          targetPull = allEntities.find(
            (entity): entity is PullEntity => entity.kind === "pr" && targetKey === mergeKey(entity.repo, entity.number),
          )
          targetUnresolved = !!target && allUnresolved.some(
            (ref) => ref.number === target.number && ref.repo !== undefined && repoKey(ref.repo) === repoKey(target.repo),
          )
        }
        // Diagnostics split attempted/deferred/frozen/unresolved every refresh,
        // even when nothing was sent (all discovery frozen or backing off).
        {
          const totalUnresolved = allUnresolved.length + plan.awaitingRetry
          setMeta("unresolved", totalUnresolved)
          const byKind = new Map<string, number>()
          for (const entity of allEntities) byKind.set(entity.kind, (byKind.get(entity.kind) ?? 0) + 1)
          const breakdown = [...byKind].map(([kind, count]) => `${count} ${kind}`).join(", ") || "none"
          const batched = batches.length > 1 ? ` in ${batches.length} calls` : ""
          const unresolved = totalUnresolved > 0 ? ` · ${totalUnresolved} unresolved (${unresolvedLabel(allUnresolved, repo)})` : " · 0 unresolved"
          const deferred = plan.deferred > 0 ? ` · ${plan.deferred} deferred` : ""
          const frozen = plan.frozen > 0 ? ` · ${plan.frozen} up-to-date` : ""
          const dropped = invalidDropped > 0 ? ` · ${invalidDropped} invalid dropped` : ""
          setMeta("stats", `${sendList.length} refs${batched} → ${allEntities.length} hydrated (${breakdown})${unresolved}${deferred}${frozen}${dropped}`)
        }
        if (branch && !isFreshBaseSession(branch ?? "", found.length)) {
          const { runs: branchRuns, prs } = await stage("branch-runs", () => client.rpc(Muninn).branchRuns({ directory: current.directory, branch }))
          // Branch runs are fetched by a separate RPC, not by the hydrate
          // operation: a newer hydrate op (e.g. the message debounce firing
          // right after this refresh's hydrate) does not invalidate them.
          // Requiring opId === lastSentOp here discarded every branch-run
          // result and left the run rows empty. Session + generation is enough.
          if (!currentRefresh()) {
            resumeInFlightBranch = undefined
            return false
          }
          setRuns(branchRunsKey(repo, branch), branchRuns)
          saveRuns(repo, branch, branchRuns)
          branchRunsBranch = branch
          if (resumeInFlightBranch === branch) resumeInFlightBranch = undefined
          merge(prs)
          for (const key of freshKeysFor([...prs, ...branchRuns])) freshKeys.add(key)
          for (const pull of prs) {
            const key = mergeKey(pull.repo, pull.number)
            if (recoveryKeys.has(key)) recoveredPulls.set(key, pull)
          }
          const branchTarget = prs.find((pull) => targetKey === mergeKey(pull.repo, pull.number))
          if (branchTarget) {
            targetPull = branchTarget
            targetUnresolved = false
          }
        }
        // Single publication point: accepted evidence for this operation, after
        // judgment and the final combined currency check below. Later stages
        // (rechain, armed merges) run only on accepted evidence, so a
        // superseded operation can never publish over — or act on — a newer
        // one's evidence.
        if (!isOperationCurrent(sessionAttemptCurrent(current, session()), generation, refreshGeneration, opId, lastSentOp)) {
          resumeInFlightBranch = undefined
          return false
        }
        for (const [key, pull] of recoveredPulls) refreshedPullByPR.set(key, pull)
        setMeta("error", hydrateError ?? null)
        await judgeFound(current.id, current.directory, found, epoch)
        // Re-verify after the async judgment (operation token included): a newer
        // hydrate operation may have started while judging. Publish this
        // operation's evidence only now, immediately before accepted
        // rechaining, so a failed judgment can never leave an incomplete
        // operation marked fresh. Never rechain or drive merges on superseded
        // evidence.
        if (!isOperationCurrent(sessionAttemptCurrent(current, session()), generation, refreshGeneration, opId, lastSentOp)) return false
        publishFreshSafety(opId, freshKeys)
        rechain()
        if (isFreshBaseSession(branch ?? "", found.length) && resumeInFlightBranch === branch) resumeInFlightBranch = undefined
        const knownPulls = Object.values(entities).filter((entity): entity is PullEntity =>
          entity.kind === "pr" && repoKey(entity.repo) === repoKey(repo),
        )
        for (const pull of knownPulls) {
          const key = mergeKey(pull.repo, pull.number)
          if (pull.state === "open") {
            // Forge said merged but hydration still sees open: keep blocking
            // only inside the confirm grace, then release so a retry (manual
            // or armed) fires without a restart.
            mergeAwaiting(key)
            continue
          }
          removeArmsForPR(pull.repo, pull.number)
          rejectedHeadByPR.delete(key)
          mergedAwaitingRefresh.delete(key)
        }
        if (targetKey && targetPull) refreshedPullByPR.set(targetKey, targetPull)
        driveArmedMerges()
        return !targetKey || targetRefreshConfirmed({
          refreshSucceeded: true,
          targetReturned: targetPull !== undefined,
          targetUnresolved,
        })
      } catch (error) {
        // Reservation release already happened at the hydrate site (same op
        // token, idempotent); anything else failing here holds no reservations.
        resumeInFlightBranch = undefined
        setMeta("error", error instanceof Error ? error.message : String(error))
        return false
      }
    })()

    const dbg = await client.rpc(Muninn).debug({}).catch(() => null)
    setMeta("debug", dbg ? `srv ${dbg.server}` : "srv ?")
    if (!currentRefresh()) return false
    return refreshed
    } finally {
      if (shouldClearActiveRefresh(refreshActiveKey, refreshActiveGeneration, key, generation))
        refreshActiveKey = undefined
    }
  }

  /** Automatic recovery refresh: skips when the identical refresh is already
   * pending, so slow repository discovery cannot be wedged by overlapping
   * polls. Session changes and explicit targeted refreshes call refresh()
   * directly and supersede via the generation guard. */
  const requestAutoRefresh = (): void => {
    const current = session()
    if (!current) return
    if (!shouldRunAutoRefresh(refreshActiveKey, refreshKeyFor(current.id, current.directory))) return
    void refresh()
  }

  // Session (or its directory) changed: re-read everything.
  createKeyed(
    () => createdKeyFor(),
    () => {
      // Entities persist across sessions (they are repo-keyed): reseed from the
      // durable cache rather than clearing.
      setEntities(cached())
      setRuns(cachedRuns())
      setChains([])
      // Created-PR memory is keyed by session identity + directory, so arriving
      // here needs no clearing: navigating back restores that session's set.
      // Verdicts belong to the session that produced them; never carry over.
      setVerdicts(undefined)
      setSessionReady(false)
      branchRunsBranch = undefined
      resumePendingBranch = undefined
      resumeInFlightBranch = undefined
      branchLoaded = false
      void refresh({ full: true })
    },
  )

  // Messages changed re-hydrates after a short debounce, so streaming text settles.
  // Toggle/provider/model changes re-judge through the same path: the effect tracks
  // them, so a settled switch schedules exactly one judgment.
  let timer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    const found = refs()
    const enabled = decisionModelsEnabled()
    const providerID = candidateProviderID()
    const model = candidateModel()
    void enabled
    void providerID
    void model
    const isFresh = fresh()
    const hadTimer = timer !== undefined
    clearTimeout(timer)
    timer = undefined
    if (hadTimer && resumePendingBranch !== undefined) resumePendingBranch = undefined
    if (isFresh) {
      refreshGeneration++
      resumePendingBranch = undefined
      resumeInFlightBranch = undefined
      rechain()
      return
    }
    if (found.length === 0) return
    const active = session()
    if (!active) return
    // Bootstrap without the sidebar: the pill gate needs meta.sessionID from
    // refresh(). If the session changed without createKeyed firing (cold
    // start, key collapse), start the refresh here (coalesced when pending).
    if (active.id !== meta.sessionID) {
      requestAutoRefresh()
      return
    }
    if (!meta.repo) return
    if (found.length > 0 && isFreshBaseSession(meta.branch, 0) && branchRunsBranch !== meta.branch && resumePendingBranch !== meta.branch && resumeInFlightBranch !== meta.branch) {
      const generationAtSchedule = refreshGeneration
      resumePendingBranch = meta.branch
      timer = setTimeout(() => {
        timer = undefined
        if (generationAtSchedule !== refreshGeneration) {
          resumePendingBranch = undefined
          return
        }
        if (isFreshBaseSession(meta.branch, refs().length)) {
          resumePendingBranch = undefined
          return
        }
        if (branchRunsBranch === meta.branch) {
          resumePendingBranch = undefined
          return
        }
        resumePendingBranch = undefined
        resumeInFlightBranch = meta.branch
        requestAutoRefresh()
      }, HYDRATE_DEBOUNCE_MS)
      return
    }
    const generationAtSchedule = refreshGeneration
    timer = setTimeout(async () => {
      timer = undefined
      if (generationAtSchedule !== refreshGeneration) return
      if (isFreshBaseSession(meta.branch, refs().length)) return
      const current = session()
      if (!current) return
      // Same shared epoch: a debounce that fires later wins over an older refresh.
      const epoch = ++judgeEpoch
      const base = refs()
      const creation = creationRequests(base)
      const admission = admitHydration({
        requested: [...base, ...creation],
        recovery: [],
        creation,
        full: false,
        gen: generationAtSchedule,
        sessionRepo: meta.repo ?? undefined,
      })
      const { sendList, batches, plan, ledger, opId } = admission
      const isDebounceCurrent = (): boolean =>
        generationAtSchedule === refreshGeneration && sessionAttemptCurrent(current, session()) && !isFreshBaseSession(meta.branch, refs().length)
      // Skip the network request when nothing is admitted, but still judge
      // and rechain below: provider/model/settings changes flow through this
      // effect and must not be dropped with frozen discovery.
      if (sendList.length === 0) {
        void judgeFound(current.id, current.directory, refs(), epoch).then(() => {
          if (!isDebounceCurrent() || opId !== lastSentOp) return
          rechain()
        })
        return
      }
      let results
      try {
        results = await Promise.all(batches.map((refs) => ctx.client.rpc(Muninn).hydrate({ directory: current.directory, refs })))
      } catch {
        releaseReservations(ledger, opId)
        return
      }
      const completed = settleHydration({
        admission,
        results,
        sessionRepo: meta.repo ?? undefined,
        isCurrent: isDebounceCurrent,
        latestOp: lastSentOp,
        onStale: () => undefined,
      })
      if (!completed) return
      merge(completed.entities)
      setMeta("unresolved", completed.unresolved.length + plan.awaitingRetry)
      // Same policy as refresh: judge before chaining, so the message
      // path never bypasses model filtering.
      await judgeFound(current.id, current.directory, refs(), epoch)
      // Re-verify after the async judgment (operation token included): a newer
      // hydrate operation may have completed while judging. Publish this
      // operation's evidence only now, immediately before accepted rechaining,
      // so a failed judgment can never leave an incomplete operation marked fresh.
      if (!isDebounceCurrent() || opId !== lastSentOp) return
      publishFreshSafety(opId, freshKeysFor(completed.entities))
      rechain()
    }, HYDRATE_DEBOUNCE_MS)
  })

  // CI state changes upstream: poll while this session has anything to show.
  // Branch moves off base must also leave the fresh state without restart.
  // The extra arms below let a cold start self-heal without the sidebar:
  // a gate mismatch (refresh never started for this session), a missing repo
  // after a failed refresh, or candidates with no chains yet all retry.
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let pollDisposed = false
  // Self-rescheduling: each tick re-arms in `.finally` from the current state,
  // so a rejected vcs.get cannot kill polling and cadence tracks run status.
  // The disposed guard stops an in-flight tick from re-arming after cleanup.
  const schedulePollAt = (ms: number): void => {
    if (pollDisposed) return
    pollTimer = setTimeout(() => {
      if (pollDisposed) return
      const current = session()
      if (current) {
        void ctx.client.vcs
          .get({ location: { directory: current.directory } })
          .then((vcs) => {
            const branch = vcs?.data?.branch?.current ?? ""
            if (current.id !== meta.sessionID) requestAutoRefresh()
            else if (meta.repo === null) requestAutoRefresh()
            else if (meta.error !== null) requestAutoRefresh()
            else if (branch !== meta.branch && (meta.branch !== "" || branchLoaded)) requestAutoRefresh()
            else if (chains().length > 0) requestAutoRefresh()
            else if (refs().length > 0) requestAutoRefresh()
          })
          .catch(() => {
            if (current.id !== meta.sessionID) requestAutoRefresh()
            else if (chains().length > 0) requestAutoRefresh()
            else if (refs().length > 0) requestAutoRefresh()
          })
          // A failed refresh leaves chains intact, so gate the fast cadence on a
          // clean last refresh: an errored forge backs off to the normal tick.
          .finally(() => schedulePollAt(meta.error !== null ? POLL_NORMAL_MS : pollInterval(chains().flatMap((chain) => chain.runs))))
      } else {
        schedulePollAt(POLL_NORMAL_MS)
      }
    }, ms)
  }
  schedulePollAt(POLL_NORMAL_MS)
  onCleanup(() => {
    pollDisposed = true
    clearTimeout(pollTimer)
    clearTimeout(timer)
  })

  // ── Component 1: pills above the composer ────────────────────────────────
  // One eligibility policy, one memo, three consumers (`show`, `menu`,
  // `debugLine`) — the same values everywhere, with no per-consumer filter for
  // the footer's census to drift away from (the failure mode the old
  // `live()`-counts-vs-`pillChains()`-pick split already produced). State-driven
  // via `pillEligible`: the session's own work pills — live branch/SHA match,
  // the sticky created set (including branch-linked `push && pr create`
  // compounds), or a deliberate same-repo mention (user/command/prose tiers;
  // output-tier never recruits) — plus the explicit pin override (merge-when-
  // ready arming never recruits a pill on its own). Cross-repo mentions stay
  // in the sidebar; settled history never pills.

  const waitForAllStatusChecks = () => ctx.stores.settings.value.waitForAllStatusChecks !== false
  const requireApproval = () => ctx.stores.settings.value.requireApproval === true
  const requireResolvedThreads = () => ctx.stores.settings.value.requireResolvedThreads === true
  /** How many one-pill-per-pick slots the composer row holds: pinned first,
   * then `pillDisplay` order. Anything beyond the cap stays in the sidebar,
   * the debug census, and the last slot's overflow row. */
  const MAX_PILLS = 5
  /** The single eligibility context behind pills, pins, and hydration
   * protection alike: deliberate same-repo mention evidence plus the live
   * session coordinates. Refresh computes the same context so hydration can
   * protect exactly the chains the pill filter would keep. */
  const eligibilityContext = () => {
    const mentioned = mentionEvidence(filteredRefs(), entities, verdictsForSession())
    return {
      sessionBranch: meta.branch || undefined,
      sessionRepo: meta.repo || undefined,
      sessionHeadSha: meta.headSha || undefined,
      created: createdKeys(),
      mentioned,
    }
  }
  /** Concrete safety refs for this refresh: every identity the freshness gate
   * may require, synthesized explicitly because marking identities protected
   * never sends anything. Armed PRs and their same-repo/current-head runs,
   * recovery targets, creation links, the explicit target, and pinned plus
   * pill-eligible members (including beyond-cap overflow). */
  const safetyRefsFor = (input: {
    recovery: readonly { repo: RepoRef; number: number }[]
    creation: readonly TieredRef[]
    target?: { repo: RepoRef; number: number }
  }): TieredRef[] =>
    safetyRefs({
      chains: chains(),
      eligibleKeys: new Set(pillState().eligible.map((chain) => chain.key)),
      pinnedKey: pinnedChain(chains(), ctx.stores.pinned.value)?.key,
      armed: ctx.stores.armed.value.entries,
      recovery: input.recovery,
      creation: input.creation,
      target: input.target,
    })
  /** Repos whose output-tier run refs ride the live lane (armed PR repos). */
  const armedHydrationRepos = (): Set<string> =>
    new Set(ctx.stores.armed.value.entries.map((entry) => repoKey(entry.repo)))
  /**
   * One hydrate admission, shared by refresh and the message debounce so the
   * two pipelines can never diverge on partition, budget, chunking, or
   * reservation semantics. Assigns the operation token, plans discovery
   * against the session ledger, and chunks the send list within this
   * operation. Callers own the RPC invocation, the completion check, and
   * post-completion work — only `settleHydration` may consume a plan.
   */
  const admitHydration = (input: {
    requested: readonly TieredRef[]
    recovery: readonly { repo: RepoRef; number: number }[]
    creation: readonly TieredRef[]
    target?: { repo: RepoRef; number: number }
    full: boolean
    gen: number
    sessionRepo: RepoRef | undefined
  }): {
    sendList: TieredRef[]
    batches: TieredRef[][]
    plan: DiscoveryPlan
    ledger: DiscoveryLedger
    opId: number
    invalid: number
  } => {
    const safety = safetyRefsFor({ recovery: input.recovery, creation: input.creation, target: input.target })
    const valid = input.requested.filter((ref) => Number.isSafeInteger(ref.number) && ref.number > 0)
    const invalid = input.requested.length - valid.length
    // Kind-aware coverage dedup: transcript refs whose payload a safety ref
    // already carries ride along inside it (see excludeCoveredRefs).
    const { kept: uncovered } = excludeCoveredRefs(valid, safety, input.sessionRepo)
    const { live, discovery } = partitionRefs(uncovered, input.sessionRepo, armedHydrationRepos())
    const ledger = discoveryLedger()
    const opId = ++hydrateOp
    lastSentOp = opId
    const discoveryBudget = Math.max(0, WIRE_REF_CAP - safety.length - live.length)
    const plan = planDiscovery(discovery, input.sessionRepo, ledger, input.gen, Date.now(), input.full, discoveryBudget, opId)
    const sendList = [...safety, ...live, ...plan.admit]
    const batches: TieredRef[][] = []
    for (let i = 0; i < sendList.length; i += WIRE_REF_CAP) batches.push(sendList.slice(i, i + WIRE_REF_CAP))
    return { sendList, batches, plan, ledger, opId, invalid }
  }
  /**
   * Shared completion: currency-guarded commit of one operation's results.
   * Stale completions release their reservations and merge nothing; RPC
   * failures release via the caller's catch (same op token — idempotent).
   * Returns the merged entity/unresolved sets for the caller to publish,
   * diagnose, and rechain from, or undefined when superseded.
   */
  const settleHydration = (input: {
    admission: { ledger: DiscoveryLedger; opId: number; plan: DiscoveryPlan }
    results: readonly { entities: readonly Entity[]; unresolved: readonly { number: number; repo?: RepoRef }[] }[]
    sessionRepo: RepoRef | undefined
    isCurrent: () => boolean
    /** Latest sent operation at settle time: only the newest sent op may commit. */
    latestOp: number
    onStale: () => void
  }): { entities: Entity[]; unresolved: { number: number; repo?: RepoRef }[] } | undefined => {
    // Op recency first: a superseded operation releases its own reservations
    // and merges nothing, even when the shared generation/session checks
    // would still pass (two debounce fires can share one generation).
    if (!shouldSettle(input.admission.opId, input.latestOp, input.isCurrent())) {
      releaseReservations(input.admission.ledger, input.admission.opId)
      input.onStale()
      return undefined
    }
    const entities: Entity[] = []
    const unresolved: { number: number; repo?: RepoRef }[] = []
    for (const result of input.results) {
      entities.push(...result.entities)
      unresolved.push(...result.unresolved)
    }
    commitDiscovery(input.admission.ledger, input.admission.plan.admit, unresolved, input.sessionRepo, Date.now())
    return { entities, unresolved }
  }
  const pillState = createMemo(() => {
    if (fresh()) return { eligible: [] as Chain[], pickable: [] as Chain[], picked: undefined as { chain: Chain; reason: PillReason; considered: number } | undefined, picks: [] as { chain: Chain; reason: PillReason }[], provenance: new Map<string, string[]>() as Map<string, string[]> }
    // Deliberate same-repo mention evidence for the pills: user/command/prose
    // survivors mapped to hydrated PRs (output-tier never enters; explicit
    // PR-kind drops excluded in the helper). Shared with the pill filter —
    // the footer reads the same provenance map, never a second filter.
    const eligibilityCtx = eligibilityContext()
    const eligible = chains().filter((chain) => pillEligible(chain, eligibilityCtx))
    const provenance = new Map(chains().map((chain) => [chain.key, eligibilityProvenances(chain, eligibilityCtx)] as const))
    // Dismissed chains leave the pool before ranking/capping (the pinned
    // entry bypasses via `pillDisplay`); `eligible` stays full for the census.
    const pickable = pickableChains(eligible, dismissedKeys())
    const normal = pillPick(pickable, waitForAllStatusChecks(), requireApproval(), requireResolvedThreads())
    // Single-pin override: pull identity (or chain key) bypasses eligibility.
    // Expiry is disappearance: a pinned chain that's gone unpins on next rechain.
    const pinned = pinnedChain(chains(), ctx.stores.pinned.value)
    const picks = pillDisplay(pickable, pinned, waitForAllStatusChecks(), MAX_PILLS, requireApproval(), requireResolvedThreads())
    if (pinned) {
      return { eligible, pickable, picked: { chain: pinned, reason: "pinned" as const, considered: pickable.length + 1 }, picks, provenance }
    }
    return { eligible, pickable, picked: normal, picks, provenance }
  })

  const isPinned = (chain: Chain): boolean => {
    const pin = ctx.stores.pinned.value
    // Membership, not lead identity: the pill resolves the same way, so the
    // pin can never disagree with it after a lead change.
    if (pin.number !== undefined && pin.repo) return pinnedChain([chain], pin) !== undefined
    if (pin.key !== undefined) return chain.key === pin.key
    return false
  }
  const togglePin = (chain: Chain): void => {
    if (isPinned(chain)) {
      // Unpinning removes the pill: the chain stays in the sidebar, and only
      // pinning re-adds it (pin clears the dismissal below).
      const key = createdKeyFor()
      setDismissedBySession((previous) => {
        const updated = new Set(previous.get(key) ?? [])
        updated.add(chain.key)
        return new Map(previous).set(key, updated)
      })
      ctx.stores.pinned.update((draft) => {
        const current = draft as Pin
        delete current.repo
        delete current.number
        delete current.kind
        delete current.key
        delete current.owner
      })
      return
    }
    const next = pinForChain(chain)
    const owner = session()?.id
    // Pinning re-adds a hidden pill: an explicit pin beats a dismissal.
    if (dismissedKeys().has(chain.key)) {
      const key = createdKeyFor()
      setDismissedBySession((previous) => {
        const updated = new Set(previous.get(key) ?? [])
        updated.delete(chain.key)
        return new Map(previous).set(key, updated)
      })
    }
    ctx.stores.pinned.update((draft) => {
      const current = draft as Pin
      if (next.repo) current.repo = next.repo
      else delete current.repo
      if (next.number !== undefined) current.number = next.number
      else delete current.number
      if (next.kind !== undefined) current.kind = next.kind
      else delete current.kind
      if (next.key !== undefined) current.key = next.key
      else delete current.key
      if (owner !== undefined) current.owner = owner
      else delete current.owner
    })
  }
  // Each pill's merge-when-ready toggle binds to its own chain's first open
  // PR. Reactive per chain — the popover updates while it's open.
  const menuLeadFor = (chain: Chain): { chain: Chain; pull: PullEntity } | undefined =>
    chain.prs.filter((pull) => pull.state === "open").map((pull) => ({ chain, pull }))[0]

  /** Removes a merged pick from the composer row without opening its popover:
   * unpins a pinned chain (which also dismisses it); otherwise records a
   * dismissal. The chain stays in the sidebar either way — only the pill goes. */
  const removeMergedPick = (chain: Chain): void => {
    if (isPinned(chain)) {
      togglePin(chain)
      return
    }
    const key = createdKeyFor()
    setDismissedBySession((previous) => {
      if ((previous.get(key) ?? EMPTY_CREATED).has(chain.key)) return previous
      const updated = new Set(previous.get(key) ?? [])
      updated.add(chain.key)
      return new Map(previous).set(key, updated)
    })
  }

  /** Whether a PR is armed for Muninn-driven merge-when-ready — ours, or already
   * armed on the forge's side (shown the same; cancel handles both). */
  const isArmed = (pull: PullEntity): boolean =>
    ctx.stores.armed.value.entries.some(
      (entry) => repoKey(entry.repo) === repoKey(pull.repo) && entry.number === pull.number,
    ) || !!pull.autoMerge

  /** Appends an evidence entry to the activity ledger, newest first, capped. */
  const record = (
    pull: PullEntity,
    kind: "merged" | "branch-deleted" | "branch-delete-failed" | "merge-failed",
    via: "manual" | "when-ready",
    method?: "merge" | "squash" | "rebase",
    detail?: string,
  ) =>
    ctx.stores.activity.update((draft) => {
      draft.entries.unshift({
        at: Date.now(),
        repo: pull.repo,
        number: pull.number,
        kind,
        via,
        ...(method ? { method } : {}),
        ...(detail ? { detail } : {}),
      })
      if (draft.entries.length > 200) draft.entries.length = 200
    })

  type MergeOutcome = "merged" | "failed" | "head-changed" | "in-flight" | "already-handled" | "transport"

  /** Provider refusals are RETURNED as `{merged:false, message:"GitHub ..."}`;
   * transport failures (plugin reload → unregistered RPC, network abort) THROW.
   * Keep the two separate: a transport failure is not a merge failure. */
  const fireMergeOnce = async (
    pull: PullEntity,
    method: "merge" | "squash" | "rebase",
    via: "manual" | "when-ready",
  ): Promise<MergeOutcome> => {
    const current = session()
    const client = ctx.client
    if (!current || !client) return "transport"
    const origin = { sessionID: current.id, directory: current.directory, repo: meta.repo }
    const deleteBranch = ctx.stores.settings.value.deleteBranch
    let result: { merged: boolean; message?: string; headChanged?: boolean; inFlight?: boolean; alreadyHandled?: boolean } | undefined
    try {
      result = await client.rpc(Muninn).merge({
        directory: current.directory,
        number: pull.number,
        method,
        expectedHeadSha: pull.headSha,
      })
    } catch (error) {
      console.warn("[muninn] merge RPC transport failure", error)
      return "transport"
    }
    if (!result) return "transport"
    if (!result.merged) {
      if (result.inFlight) {
        if (via === "manual")
          ctx.toast.show({ title: `PR #${pull.number} merge already in progress`, variant: "default" })
        return "in-flight"
      }
      if (result.alreadyHandled) {
        if (via === "manual")
          ctx.toast.show({ title: `PR #${pull.number} was already merged`, variant: "default" })
        return "already-handled"
      }
      if (result.headChanged) {
        ctx.toast.show({
          title: `PR #${pull.number} head changed`,
          description: via === "when-ready"
            ? "Refreshing the latest head; Muninn will retry only after its checks and reviews are ready."
            : "Refreshing the latest PR state. Review readiness and retry the merge against the new head.",
          variant: "default",
        })
        return "head-changed"
      }
      record(pull, "merge-failed", via, method, result.message)
      ctx.toast.show({ title: `PR #${pull.number} merge failed`, description: result.message, variant: "error" })
      return "failed"
    }
    mergedAwaitingRefresh.set(mergeKey(pull.repo, pull.number), Date.now())
    record(pull, "merged", via, method)
    let description = `${method} into ${pull.baseBranch}`
    const fastForward = shouldFastForwardBase(ctx.stores.settings.value.fastForwardBase ?? false, result.merged)
    if (deleteBranch) {
      // Canonical checkouts skip the standalone fast-forward: the canonical
      // flow fast-forwards after switching to the base branch instead.
      const kind = await checkoutKind(origin.directory)
      if (kind !== "canonical" && fastForward) {
        const update = await fastForwardLocalBase(origin, pull)
        description += ` · ${update.message ?? (update.fastForwarded ? "local base fast-forwarded" : "local base unchanged")}`
      }
      const raw = kind === "canonical"
        ? await cleanupCanonicalBranch(origin, pull, fastForward)
        : await cleanupTreeAndBranch(origin, pull)
      // Normalise: only the canonical path reports the base-update attempt.
      const cleanup = { ...raw, fastForwardAttempted: "fastForwardAttempted" in raw ? raw.fastForwardAttempted : false }
      if (cleanup.deleted) {
        record(pull, "branch-deleted", via, method)
        description += ` · ${cleanup.message}`
      } else {
        if (shouldRecordCleanupFailure(cleanup.attempted, cleanup.deleted))
          record(pull, "branch-delete-failed", via, method, cleanup.message)
        description += ` · ${cleanup.message}`
      }
      // A canonical bail before switching (already on base, dirty tree, not
      // on the PR branch) skips the in-flow update: fall back to the
      // standalone fast-forward unless one already ran.
      if (kind === "canonical" && fastForward && !cleanup.fastForwardAttempted) {
        const update = await fastForwardLocalBase(origin, pull)
        description += ` · ${update.message ?? (update.fastForwarded ? "local base fast-forwarded" : "local base unchanged")}`
      }
    } else if (fastForward) {
      const update = await fastForwardLocalBase(origin, pull)
      description += ` · ${update.message ?? (update.fastForwarded ? "local base fast-forwarded" : "local base unchanged")}`
    }
    ctx.toast.show({ title: `PR #${pull.number} merged`, description, variant: "success" })
    return "merged"
  }

  /** A plugin reload briefly unregisters the merge RPC. A transport failure is
   * not a merge failure: manual clicks retry in-process with bounded backoff
   * and only surface an availability notice if all attempts fail; armed merges
   * return immediately and are re-driven by the next poll, which rechecks
   * consent and readiness. Neither records merge-failed nor disarms an arm.
   * Provider refusals resolve normally and never enter the transport retry
   * loop (a stale-head response can still start a fresh armed attempt against
   * the updated head). The server's process-local coordinateMerge dedupes a
   * retry racing a success committed before the connection died. */
  const MERGE_TRANSPORT_BACKOFF_MS = [1_000, 2_000, 4_000]
  const fireMerge = async (
    pull: PullEntity,
    method: "merge" | "squash" | "rebase",
    via: "manual" | "when-ready",
  ): Promise<MergeOutcome> => {
    const attemptSession = session()
    for (let attempt = 0; ; attempt++) {
      const outcome = await fireMergeOnce(pull, method, via)
      if (outcome !== "transport") return outcome
      // Armed merges must not outlive consent: a disarm or gate change during a
      // backoff would not be seen. Leave the arm intact and let the next poll's
      // driveArmedMerges recheck it. Manual clicks have no such long-lived intent.
      if (via === "when-ready") return "transport"
      const backoff = MERGE_TRANSPORT_BACKOFF_MS[attempt]
      if (backoff === undefined || !sessionAttemptCurrent(attemptSession, session())) return "transport"
      await new Promise<void>((resolve) => setTimeout(resolve, backoff + Math.floor(Math.random() * backoff / 4)))
      if (!sessionAttemptCurrent(attemptSession, session())) return "transport"
    }
  }

  /** Merges a pull request now: confirms in the app's dialog (naming exactly what
   * happens), then fires the provider merge guarded by the PR's head SHA. */
  const mergePull = async (pull: PullEntity): Promise<void> => {
    const method = ctx.stores.settings.value.mergeMethod
    const deleteBranch = ctx.stores.settings.value.deleteBranch
    const fastForward = ctx.stores.settings.value.fastForwardBase
    const reviewNotice = pendingReviewNotice(pull, requireApproval())
    const kind = await checkoutKind(session()?.directory ?? "")
    const methodName = `${method[0]!.toUpperCase()}${method.slice(1)}`
    const cleanupClause = !deleteBranch
      ? ""
      : kind === "canonical"
        ? `, switches to ${pull.baseBranch}${fastForward ? ", fast-forwards it when safe," : ""} and deletes the local branch ${pull.headBranch}`
        : ` and deletes the clean local tree and branch ${pull.headBranch}`
    const ffClause = fastForward && (!deleteBranch || kind !== "canonical")
      ? ` and fast-forwards the local ${pull.baseBranch} when safe`
      : ""
    const ok = await ctx.dialogs.confirm({
      title: reviewNotice ? `Merge PR #${pull.number} without approval?` : `Merge PR #${pull.number}?`,
      description: `${methodName}-merges "${pull.title}" into ${pull.baseBranch}${cleanupClause}${ffClause}.${reviewNotice ? ` ${reviewNotice[0]!.toUpperCase()}${reviewNotice.slice(1)} — merge anyway?` : ""}`,
      confirm: "Merge",
      danger: true,
    })
    if (!ok) return
    const outcome = await fireMerge(pull, method, "manual")
    if (outcome === "transport") {
      ctx.toast.show({
        title: `PR #${pull.number} merge unavailable`,
        description: "Muninn couldn't confirm the merge outcome while its forge connection was reloading. Check the PR before retrying.",
        variant: "default",
      })
      return
    }
    void refresh({ full: true })
  }

  /** Arms or disarms merge-when-ready. Arming is local — Muninn watches the chain
   * and fires the merge itself when checks and reviews are green; the forge's own
   * auto-merge is never used. Arming confirms once; that consent carries. */
  const armPull = async (pull: PullEntity, enable: boolean): Promise<void> => {
    if (enable) {
      const method = ctx.stores.settings.value.mergeMethod
      const deleteBranch = ctx.stores.settings.value.deleteBranch
      const fastForward = ctx.stores.settings.value.fastForwardBase
      const reviewNotice = pendingReviewNotice(pull, requireApproval())
      const kind = await checkoutKind(session()?.directory ?? "")
      const sentences = [`Muninn watches "${pull.title}" and merges into ${pull.baseBranch} with ${method} once checks pass and merge requirements are satisfied.`]
      if (fastForward && (!deleteBranch || kind !== "canonical"))
        sentences.push(`It will also fast-forward the local ${pull.baseBranch} when safe.`)
      if (deleteBranch)
        sentences.push(kind === "canonical"
          ? `It will switch to ${pull.baseBranch}${fastForward ? ", fast-forward it when safe," : ""} and delete the local branch ${pull.headBranch} when possible.`
          : `It will delete the clean local tree and branch ${pull.headBranch} when possible.`)
      if (reviewNotice) sentences.push(`${reviewNotice[0]!.toUpperCase()}${reviewNotice.slice(1)} — Muninn will wait for an approval before merging.`)
      sentences.push("You can cancel any time.")
      const ok = await ctx.dialogs.confirm({
        title: `Merge PR #${pull.number} when ready?`,
        description: sentences.join(" "),
        confirm: "Merge when ready",
      })
      if (!ok) return
      ctx.stores.armed.update((draft) => {
        if (!draft.entries.some((entry) => repoKey(entry.repo) === repoKey(pull.repo) && entry.number === pull.number))
          draft.entries.push({ repo: pull.repo, number: pull.number, method, armID: crypto.randomUUID() })
      })
      void refresh({ full: true })
      return
    }
    // Disarm: drop our entry; also cancel an arm the user made on the forge.
    removeArmsForPR(pull.repo, pull.number)
    rejectedHeadByPR.delete(mergeKey(pull.repo, pull.number))
    const current = session()
    const client = ctx.client
    if (pull.autoMerge && current && client)
      await client
        .rpc(Muninn)
        .autoMerge({ directory: current.directory, number: pull.number, enable: false, method: pull.autoMerge })
        .catch((error: unknown) => console.error("[muninn] forge disarm failed", error))
    void refresh({ full: true })
  }

  /** Fires ready armed entries once per PR. A stale head stays armed but is
   * blocked until a successful refresh observes a different head SHA. */
  const driveArmedMerges = () => {
    for (const { pull, chain, method } of armedTargets(ctx.stores.armed.value.entries, chains(), waitForAllStatusChecks(), requireApproval(), requireResolvedThreads())) {
      const key = mergeKey(pull.repo, pull.number)
      // Freshness gate: the armed PR and every current-head run the merge
      // decision will read must be fresh in the latest accepted operation.
      // Evidence from a superseded operation — or none at all — fails closed
      // here and retries on the next successful hydration.
      const requiredRuns = chain.runs
        .filter((run) => repoKey(run.repo) === repoKey(pull.repo) && run.headSha === pull.headSha)
        .map((run) => freshKeyFor(run.repo, "run", run.id))
      if (!armedMergeEligible(freshSafety, createdKeyFor(), lastSentOp, [freshKeyFor(pull.repo, "pr", pull.number), ...requiredRuns])) continue
      if (
        mergeInFlight.has(key) ||
        mergeAwaiting(key) ||
        (serverBusyUntil.get(key) ?? 0) > Date.now()
      ) continue
      const entry = ctx.stores.armed.value.entries.find(
        (candidate) => mergeKey(candidate.repo, candidate.number) === key && candidate.method === method,
      )
      if (!entry) continue
      const rejectedHead = rejectedHeadByPR.get(key)
      if (rejectedHead !== undefined) {
        const evidence = refreshedPullByPR.get(key)
        if (
          !evidence ||
          !staleHeadEvidenceUsable({
            rejectedHeadSha: rejectedHead,
            candidateHeadSha: pull.headSha,
            confirmedHeadSha: evidence.headSha,
          })
        ) continue
        refreshedPullByPR.delete(key)
        rejectedHeadByPR.delete(key)
      }
      mergeInFlight.add(key)
      const attempt = { ...entry }
      const attemptSession = session()
      void (async () => {
        const outcome = await fireMerge(pull, method, "when-ready")
        if (outcome === "head-changed") rejectedHeadByPR.set(key, pull.headSha)
        if (outcome === "merged") {
          removeArm(attempt)
          rejectedHeadByPR.delete(key)
        }
        if (outcome === "failed") removeArm(attempt)
        if (outcome === "already-handled") removeArm(attempt)

        // Transport failure is not a merge failure: keep the arm and skip the
        // refresh (which would hit the forge while its RPC is still churning).
        if (outcome === "transport") {
          mergeInFlight.delete(key)
          return
        }

        if (outcome === "in-flight") {
          serverBusyUntil.set(key, Date.now() + 25_000)
          mergeInFlight.delete(key)
          return
        }
        serverBusyUntil.delete(key)

        if (
          !sessionAttemptCurrent(attemptSession, session())
        ) {
          mergeInFlight.delete(key)
          return
        }

        const refreshed = await refresh({ target: pull })
        mergeInFlight.delete(key)
        if (!sessionAttemptCurrent(attemptSession, session())) return

        if (outcome === "head-changed") {
          const stillArmed = ctx.stores.armed.value.entries.some(
            (candidate) => mergeKey(candidate.repo, candidate.number) === key,
          )
          if (!stillArmed) rejectedHeadByPR.delete(key)
          const currentPull = refreshedPullByPR.get(key)
          const ready = armedTargets(ctx.stores.armed.value.entries, chains(), waitForAllStatusChecks(), requireApproval(), requireResolvedThreads()).some(
            (target) => mergeKey(target.pull.repo, target.pull.number) === key,
          )
          if (staleHeadRetryEligible({
            via: "when-ready",
            headChanged: true,
            armed: stillArmed,
            refreshSucceeded: refreshed,
            inFlight: mergeInFlight.has(key),
            rejectedHeadSha: pull.headSha,
            currentHeadSha: currentPull?.headSha,
            ready,
          })) driveArmedMerges()
          return
        }
        if (outcome === "failed") driveArmedMerges()
      })()
    }
  }

  // Diagnostics footer: the pills' full decision state, plus which builds are loaded.
  const debugLine = () => {
    const current = session()
    const gate = current?.id === meta.sessionID ? "✓" : "✗"
    const { eligible, pickable, picked, picks, provenance } = pillState()
    // Every capsule in display order, then the lead's why: which rule won and
    // out of how many candidates, and how the chain chose its lead PR. Read
    // from the same memo the capsules use — eligibility and picks are never
    // recomputed per consumer. Lead selection is the shared `pillLeadOf`
    // policy, so the footer can never name a different PR than the capsule.
    const lead = picked ? pillLeadOf(picked.chain, picked.reason) : undefined
    const pill = picks.length === 0
      ? eligible.length === 0
        ? "off: nothing eligible"
        : pickable.length === 0
          ? "off: all dismissed"
          : "off: no eligible chains"
      : picks
          .map(({ chain, reason }) => {
            const chainLead = pillLeadOf(chain, reason)
            const chainRun = chainLead ? undefined : latestRun(chain.runs)
            if (chainLead) return `#${chainLead.number} ${chainLead.title.slice(0, 36)}${chainLead.state === "merged" ? " · merged" : ""}`
            if (chainRun) return `run #${chainRun.id}`
            return "off"
          })
          .join(" | ")
    // Pipeline census: refs by provenance tier, how many hit the entity store,
    // how big the store is. A PR that reaches hydration but not the pill — or a
    // tool-discovery that wrongly became a candidate — gets caught here.
    const refList = refs()
    const tiers = { user: 0, command: 0, prose: 0, output: 0 }
    let hits = 0
    for (const ref of refList) {
      tiers[ref.tier]++
      const base = ref.repo ? repoKey(ref.repo) : undefined
      const found = ref.kind
        ? entities[refKey(ref)] !== undefined
        : base !== undefined &&
          ["issue", "pr", "run"].some((kind) => entities[`${base}#${kind}${ref.number}`] !== undefined)
      if (found) hits++
    }
    const pick = !picked
      ? "pick: none"
      : `pick: ${picked.reason}${picked.considered > 1 ? ` of ${picked.considered}` : ""} · lead ${
          picked.chain.prs[0] ? (picked.chain.prs[0].headBranch === meta.branch ? "branch match" : "newest") : "—"
        }`
    // Per-dot eligibility provenance from the same memo the capsules use:
    // every applicable rule joined (`branch+mention`), with the explicit
    // pin override listed first when it applies (`pinned+created`).
    const via = picks.length === 0 ? "" : ` · via ${picks
      .map(({ chain, reason }) => {
        const lead = pillLeadOf(chain, reason)
        const rules = provenance.get(chain.key) ?? []
        const shown = isPinned(chain) ? ["pinned", ...rules] : rules.length > 0 ? rules : ["none"]
        return `#${lead?.number ?? "?"}:${shown.join("+")}`
      })
      .join(", ")}`
    const error = meta.error ? ` · err ${meta.error.slice(0, 200)}` : ""
    const pullEvidence = pillPullDiagnostics(lead)
    return `mn gui ${__MN_BUILD__}${meta.debug ? ` · ${meta.debug}` : " · srv ?"} · gate ${gate} ${current?.id ?? "?"} · chains ${chains().length} · eligible ${eligible.length} · pill: ${pill} · ${pick}${via}${pullEvidence ? ` · ${pullEvidence}` : ""} · refs ${refList.length} (user ${tiers.user} cmd ${tiers.command} prose ${tiers.prose} out ${tiers.output}) → hits ${hits}/${Object.keys(entities).length} ents${error}${meta.stats ? ` · ${meta.stats}` : ""}`
  }

  /** The braille spinner frames for the pill's pending-merge indicator. The host
   * re-runs the pill's `show` reactively, so ticking this signal animates the
   * capsule label live while an armed PR waits. */
  const SPIN_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
  const [spin, setSpin] = createSignal(0)
  const spinTimer = setInterval(() => setSpin((frame) => (frame + 1) % SPIN_FRAMES.length), 140)
  onCleanup(() => clearInterval(spinTimer))


  const runGlyph = (status: RunStatus): JSX.Element => {
    if (status === "succeeded") return <CheckGlyph />
    if (status === "failed") return <CrossGlyph />
    if (status === "cancelled") return <CancelledGlyph />
    if (status === "running") return <span class="mn-spin" />
    return <QueuedGlyph />
  }

  const copyLink = (event: MouseEvent, url: string): void => {
    event.stopPropagation()
    void ctx.system.copy(url).catch(() => undefined)
  }

  const sessionsAtWorktree = async (directory: string) => {
    const projects = await ctx.client.project.list()
    const lists = await Promise.all(projects.map(async (project) => {
      const first = await ctx.client.session.list({ project: project.id, limit: 100 })
      const sessions = [...first.data]
      const seen = new Set<string>()
      let cursor = first.cursor.next ?? undefined
      while (cursor) {
        if (seen.has(cursor)) throw new Error("session list pagination repeated a cursor")
        seen.add(cursor)
        const page = await ctx.client.session.list({ project: project.id, limit: 100, cursor })
        sessions.push(...page.data)
        cursor = page.cursor.next ?? undefined
      }
      return sessions.map((item) => ({
        id: item.id,
        directory: item.location.directory,
        parentID: item.parentID,
        outcome: item.outcome,
        time: { busy: item.time.busy, idle: item.time.idle, archived: item.time.archived },
      }))
    }))
    return lists.flat()
  }

  /** Whether the session directory is a linked worktree, a project canonical
   * checkout, or outside managed checkouts. Never throws: unknowns route to
   * the worktree cleanup path, which reports its own errors. */
  const checkoutKind = async (directory: string): Promise<CheckoutKind> => {
    try {
      const client = ctx.client
      if (!client) return "unmanaged"
      const located = []
      for (const project of await client.project.list()) {
        const trees = await client.worktree.list({ projectID: project.id }).catch(() => [])
        located.push({ canonical: project.canonical, trees: trees.map((tree) => tree.directory) })
      }
      return locateCheckout(located, directory)
    } catch {
      return "unmanaged"
    }
  }

  /** Post-merge cleanup for a canonical checkout: the session stays put, so
   * switch it to the base branch, fast-forward when enabled, and delete the
   * merged branch. Force-deletion is safe here: the PR merged on the forge,
   * the local tip equals the merged head, and the tree is clean. Reports
   * whether the base update ran so the caller can fall back to a standalone
   * fast-forward when cleanup bails first. */
  const cleanupCanonicalBranch = async (
    origin: { sessionID: string; directory: string; repo: RepoRef | null | undefined },
    pull: PullEntity,
    fastForward: boolean,
  ) => {
    const client = ctx.client
    let branchDeleteAttempted = false
    let fastForwardAttempted = false
    const parts: string[] = []
    const fail = (message: string) => ({ deleted: false, attempted: branchDeleteAttempted, fastForwardAttempted, message: [...parts, message].join(" · ") })
    try {
      if (!cleanupSessionMatches(origin.sessionID, session()?.id))
        return fail("active session changed during merge; local checkout left intact")
      const directory = origin.directory
      const sameRepo = !!origin.repo && repoKey(origin.repo) === repoKey(pull.repo)
      if (!sameRepo)
        return fail(cleanupDecision({ enabled: true, merged: true, sameRepo, managedWorktree: false, branchMatches: false, headMatches: false, clean: false }).message ?? "PR belongs to another repository; local checkout left intact")
      const sessions = await sessionsAtWorktree(directory)
      const occupancy = worktreeOccupancyDecision(sessions, origin.sessionID, directory, false)
      if (!occupancy.safe) return fail(occupancy.message ?? "another session uses this checkout; local branch left intact")
      const check = await client.rpc(Muninn).checkLocalWorktree({ directory, branch: pull.headBranch, expectedHeadSha: pull.headSha, trackedOnly: true })
      const decision = cleanupDecision({
        enabled: true,
        merged: true,
        sameRepo,
        managedWorktree: true,
        branchMatches: check.eligible,
        headMatches: check.eligible,
        clean: check.eligible,
      })
      if (!decision.remove) return fail(check.message ?? decision.message ?? "local checkout is not ready; left it intact")
      if (!cleanupSessionMatches(origin.sessionID, session()?.id))
        return fail("active session changed during cleanup; checkout left intact")
      const switched = await client.rpc(Muninn).checkoutBase({ directory, baseBranch: pull.baseBranch })
      if (!switched.switched && switched.previous !== pull.baseBranch)
        return fail(switched.message ?? `could not switch to ${pull.baseBranch}; checkout left intact`)
      parts.push(switched.switched ? `switched to ${pull.baseBranch}` : `already on ${pull.baseBranch}`)
      if (fastForward) {
        fastForwardAttempted = true
        const update = await fastForwardLocalBase(origin, pull)
        parts.push(update.message ?? (update.fastForwarded ? "local base fast-forwarded" : "local base unchanged"))
      }
      branchDeleteAttempted = true
      const result = await client.rpc(Muninn).deleteLocalBranch({ directory, branch: pull.headBranch, expectedHeadSha: pull.headSha, force: true })
      if (result.deleted)
        return { deleted: true, attempted: branchDeleteAttempted, fastForwardAttempted, message: [...parts, `local branch ${pull.headBranch} deleted`].join(" · ") }
      return fail(result.message ?? "local branch could not be safely deleted")
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return {
        deleted: false,
        attempted: branchDeleteAttempted,
        fastForwardAttempted,
        message: parts.length > 0
          ? [...parts, `local cleanup failed: ${detail}`].join(" · ")
          : `local cleanup failed; checkout and branch left intact: ${detail}`,
      }
    }
  }

  const cleanupTreeAndBranch = async (
    origin: { sessionID: string; directory: string; repo: RepoRef | null | undefined },
    pull: PullEntity,
  ) => {
    const client = ctx.client
    let treeRemoved = false
    let sessionMoved = false
    let branchDeleteAttempted = false
    try {
      if (!cleanupSessionMatches(origin.sessionID, session()?.id))
        return { deleted: false, attempted: branchDeleteAttempted, message: "active session changed during merge; local tree left intact" }
      const directory = origin.directory
      const sameRepo = !!origin.repo && repoKey(origin.repo) === repoKey(pull.repo)
      if (!sameRepo)
        return { deleted: false, attempted: branchDeleteAttempted, message: cleanupDecision({ enabled: true, merged: true, sameRepo, managedWorktree: false, branchMatches: false, headMatches: false, clean: false }).message }
      for (const project of await client.project.list()) {
        const trees = await client.worktree.list({ projectID: project.id }).catch(() => [])
        if (!trees.some((tree) => tree.directory === directory)) continue
        const beforeSessions = await sessionsAtWorktree(directory)
        const beforeOccupancy = worktreeOccupancyDecision(beforeSessions, origin.sessionID, directory, false)
        if (!beforeOccupancy.safe) return { deleted: false, attempted: branchDeleteAttempted, message: beforeOccupancy.message }
        const check = await client.rpc(Muninn).checkLocalWorktree({ directory, branch: pull.headBranch, expectedHeadSha: pull.headSha })
        const decision = cleanupDecision({
          enabled: true,
          merged: true,
          sameRepo,
          managedWorktree: true,
          branchMatches: check.eligible,
          headMatches: check.eligible,
          clean: check.eligible,
        })
        if (!decision.remove) return { deleted: false, attempted: branchDeleteAttempted, message: check.message ?? decision.message }
        const base = await client.vcs.get({ location: { directory: project.canonical } }).catch(() => undefined)
        const baseClean = await client.rpc(Muninn).checkClean({ directory: project.canonical }).catch(() => undefined)
        const baseDecision = baseCheckoutDecision({
          differentTree: project.canonical !== directory,
          onBaseBranch: base?.data.branch?.current === pull.baseBranch,
          clean: cleanFromCheck(baseClean),
          cleanMessage: baseClean?.message,
        })
        if (!baseDecision.move) return { deleted: false, attempted: branchDeleteAttempted, message: baseDecision.message }
        if (!cleanupSessionMatches(origin.sessionID, session()?.id))
          return { deleted: false, attempted: branchDeleteAttempted, message: "active session changed during cleanup; worktree left intact" }
        await client.session.move({ sessionID: origin.sessionID, directory: project.canonical })
        const moved = await (async () => {
          for (const attempt of Array.from({ length: 20 }, (_, index) => index)) {
            const updated = await client.session.get({ sessionID: origin.sessionID }).catch(() => undefined)
            if (sessionMoveConfirmed(updated?.location.directory, project.canonical)) return true
            if (attempt < 19) await new Promise((resolve) => setTimeout(resolve, 100))
          }
          return false
        })()
        if (!moved)
          return { deleted: false, attempted: branchDeleteAttempted, message: "session move is pending or unconfirmed; old worktree left intact" }
        sessionMoved = true
        const afterSessions = await sessionsAtWorktree(directory)
        const afterOccupancy = worktreeOccupancyDecision(afterSessions, origin.sessionID, directory, true)
        if (!afterOccupancy.safe)
          return { deleted: false, attempted: branchDeleteAttempted, message: cleanupResultMessage(false, false, afterOccupancy.message, sessionMoved) }
        await client.worktree.remove({ projectID: project.id, directory, force: false })
        treeRemoved = true
        branchDeleteAttempted = true
        const result = await client.rpc(Muninn).deleteLocalBranch({ directory: project.canonical, branch: pull.headBranch, expectedHeadSha: pull.headSha })
        return result.deleted
          ? { deleted: true, attempted: branchDeleteAttempted, message: cleanupResultMessage(true, true, undefined, sessionMoved) }
          : { deleted: false, attempted: branchDeleteAttempted, message: cleanupResultMessage(true, false, result.message ?? "branch could not be safely deleted", sessionMoved) }
      }
      return { deleted: false, attempted: branchDeleteAttempted, message: cleanupDecision({ enabled: true, merged: true, sameRepo, managedWorktree: false, branchMatches: false, headMatches: false, clean: false }).message }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return {
        deleted: false,
        attempted: branchDeleteAttempted,
        message: treeRemoved
          ? cleanupResultMessage(true, false, `branch deletion failed or could not be confirmed: ${detail}`, sessionMoved)
          : cleanupResultMessage(false, false, sessionMoved ? `worktree removal failed: ${detail}` : `local cleanup failed; tree and branch left intact: ${detail}`, sessionMoved),
      }
    }
  }

  const fastForwardLocalBase = async (
    origin: { sessionID: string; directory: string; repo: RepoRef | null | undefined },
    pull: PullEntity,
  ) => {
    const client = ctx.client
    try {
      if (!cleanupSessionMatches(origin.sessionID, session()?.id))
        return { fastForwarded: false, message: "active session changed; local base left unchanged" }
      if (!origin.repo || repoKey(origin.repo) !== repoKey(pull.repo))
        return { fastForwarded: false, message: "PR belongs to another repository; local base left unchanged" }
      for (const project of await client.project.list()) {
        const trees = await client.worktree.list({ projectID: project.id }).catch(() => [])
        if (project.canonical !== origin.directory && !trees.some((tree) => tree.directory === origin.directory)) continue
        return safeFastForward(client.rpc(Muninn).fastForwardBase({ directory: project.canonical, repo: pull.repo, baseBranch: pull.baseBranch }))
      }
      return { fastForwarded: false, message: "could not identify the local base checkout" }
    } catch (error) {
      return { fastForwarded: false, message: `local fast-forward failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  // ── Component 1: one pill per pick above the composer ──────────────────────
  // One eligibility policy, one memo, two consumers (`show`, `menu`) plus the
  // `debugLine` census — the same values everywhere. State-driven via
  // `pillEligible`: only the session's own work pills — live branch/SHA
  // match plus the sticky created set, so sequential multi-PR sessions keep
  // every created PR (still shown after merging). Mentions of other branches'
  // work stay in the sidebar; settled history never pills.
  //
  // One pill per pick (slots links-0..MAX_PILLS): each displayed pick renders
  // its own collapsed pill with its own icon, tone, visible kind-appropriate
  // identity, and accessible name — no anonymous dots. The host owns the
  // capsule and the popover heading (`title`, else `label`).
  /** Displayed picks: dismissal-filtered (pinned entries always survive). */
  const visiblePicks = (): readonly { chain: Chain; reason: PillReason }[] =>
    applyDismissal(pillState().picks, dismissedKeys())
  const pillSlotView = (index: number) => {
    // Pinned chains bypass eligibility and dismissal, so the gate is the
    // visible picks alone: an empty eligible list with a pin must still show
    // the pill. Menu pills never show merged picks — those render through the
    // action-only contribution below, so a merged chain can never open a
    // dropdown.
    const entry = visiblePicks()[index]
    if (!entry) return undefined
    if (pillLeadOf(entry.chain, entry.reason)?.state === "merged") return undefined
    const pull = pillLeadOf(entry.chain, entry.reason)
    const armed = pull?.state === "open" ? isArmed(pull) : false
    return pillViewForPick(entry, {
      waitForAllStatusChecks: waitForAllStatusChecks(),
      requireApproval: requireApproval(),
      requireResolvedThreads: requireResolvedThreads(),
      armed,
      spinFrame: SPIN_FRAMES[spin() % SPIN_FRAMES.length] ?? "",
      t: (key) => ctx.t(key),
    })
  }
  /** Final action-pill view for a visible slot: the shared merged-action view plus the all-merged overflow suffix and the host-routed run. The single computation behind both the contribution and the pin marker's expected title (markMergedPins reads this, never a divergent copy), so appending the suffix can never desync the hover pin. The visible label is untouched, so the capsule width holds. */
  const mergedActionViewFor = (index: number): (PillView & { run: () => void }) | undefined => {
    const picks = visiblePicks()
    const entry = picks[index]
    if (!entry || pillLeadOf(entry.chain, entry.reason)?.state !== "merged") return undefined
    const view = mergedActionView(entry, (key) => ctx.t(key), waitForAllStatusChecks(), requireApproval(), requireResolvedThreads())
    if (!view) return undefined
    // Overflow's visible row lives on the last menu pill; with zero menu pills
    // (every pick merged) the count survives only here, in the accessible name
    // of the last capsule. Explicitly accepted product tradeoff: no popover
    // host exists by construction, and the unpin run must not also open history.
    const overflow = pillSlotOverflow()
    const title =
      index === picks.length - 1 && lastMenuIndex(picks) === -1 && overflow > 0
        ? `${view.title} · ${overflowLabel(overflow)}`
        : view.title
    return { ...view, title, run: () => removeMergedPick(entry.chain) }
  }
  /** Action-only view for merged picks: no dropdown chevron, the title names
   * the click action (unpin vs dismiss), and `run` removes the pill. The host
   * routes the click to this contribution's `run`, so no capture-phase
   * interception — and no wrong-pill risk — is needed. */
  const mergedPillSlotView = (index: number) => mergedActionViewFor(index)
  // Hover pin marker for verified merged-action capsules only. The host owns
  // the capsule DOM and exposes no contribution identity, so scope by exact
  // full label + accessible title match against our own merged picks (fail
  // closed: zero or ambiguous matches mark nothing). Never substring-match
  // user-controlled PR titles — an open PR titled `· merged` must not restyle.
  const PIN_CLASS = "mn-merged-unpin"
  const markMergedPins = (): void => {
    if (typeof document === "undefined") return
    const picks = visiblePicks()
    const merged = picks.filter((entry) => pillLeadOf(entry.chain, entry.reason)?.state === "merged")
    if (merged.length === 0) {
      for (const button of Array.from(document.querySelectorAll(`button[data-slot="session-plugin-pill"].${PIN_CLASS}`)))
        button.classList.remove(PIN_CLASS)
      return
    }
    const expected = new Map<string, { label: string; title: string; count: number }>()
    for (let index = 0; index < picks.length; index++) {
      const view = mergedActionViewFor(index)
      if (!view) continue
      const key = `${view.label}\n${view.title}`
      const previous = expected.get(key)
      expected.set(key, { label: view.label, title: view.title, count: (previous?.count ?? 0) + 1 })
    }
    // Two-pass grouping: a key marks its button only when exactly one pick
    // produced it AND exactly one capsule carries it. A second capsule with
    // byte-identical label + title (another plugin echoing our strings, or two
    // same-numbered/same-titled merged picks across repos) marks nothing —
    // visual and routing both fail closed on ambiguity.
    const buttons = Array.from(document.querySelectorAll('button[data-slot="session-plugin-pill"]'))
    const byKey = new Map<string, Element[]>()
    const buttonKey = new Map<Element, string | undefined>()
    for (const button of buttons) {
      const label = button.getAttribute("aria-label")
      const key = label === null ? undefined : `${button.textContent ?? ""}\n${label}`
      buttonKey.set(button, key)
      if (key === undefined) continue
      const group = byKey.get(key)
      if (group) group.push(button)
      else byKey.set(key, [button])
    }
    for (const button of buttons) {
      const key = buttonKey.get(button)
      const match = key === undefined ? undefined : expected.get(key)
      const unique = key !== undefined && match !== undefined && match.count === 1 && byKey.get(key)?.length === 1
      button.classList.toggle(PIN_CLASS, unique)
    }
  }
  if (typeof document !== "undefined" && typeof MutationObserver !== "undefined") {
    createEffect(() => {
      visiblePicks()
      waitForAllStatusChecks()
      // Read locale reactively so translated titles re-mark after a switch.
      void ctx.t("state.merged")
      queueMicrotask(markMergedPins)
    })
    const pinsObserver = new MutationObserver((mutations) => {
      if (!mutations.some((mutation) =>
        mutation.type === "childList" ||
        (mutation.type === "attributes" && mutation.attributeName !== "class")
      )) return
      queueMicrotask(markMergedPins)
    })
    pinsObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-label"] })
    onCleanup(() => pinsObserver.disconnect())
  }
  /** Filtered-pool chains absent from the displayed picks (an ineligible pin consuming a slot shrinks the displayed-eligible count by one; dismissed chains never inflate it). */
  const pillSlotOverflow = (): number => overflowCount(pillState().pickable, pillState().picks)

  // One chain's rows: PRs, issues, runs. Rendered by each slot's popover for
  // its own chain.
  const pillChainRows = (chain: Chain, input: ComposerPillMenuProps): JSX.Element => (
        <div class="mn-pop-chain" data-tone={chainTone(chain, waitForAllStatusChecks(), requireApproval(), requireResolvedThreads())}>
          <For each={chain.prs}>
            {(pull) => (
              <div class="mn-pop-row" onClick={() => { input.close(); open(pull.url) }}>
                <span
                  class="mn-kind"
                  data-state={prConflicted(pull) ? "pr-conflict" : `pr-${pull.state}`}
                  title={ctx.t(prConflicted(pull) ? "state.pr-conflict" : `state.${pull.state}`)}
                >
                  {pull.state === "merged" ? <MergedGlyph /> : prConflicted(pull) ? <PullConflictGlyph /> : <PullGlyph />}
                </span>
                <span
                  class="mn-merge-state"
                  data-state={pull.state === "merged" ? "merged" : pull.mergeState ?? "unknown"}
                  data-armed={isArmed(pull) ? "" : undefined}
                  title={`merge: ${pull.state === "merged" ? "merged" : pull.mergeState ?? "unknown"}${pull.reviewState ? ` · reviews: ${pull.reviewState}` : ""}${isArmed(pull) ? " · Muninn is watching" : ""}`}
                >
                  {(pull.state === "open" || pull.state === "draft") && pull.mergeState == null ? <UnknownGlyph /> : <MergeGlyph />}
                </span>
                <span class="mn-pop-id">#{pull.number}</span>
                <span class="mn-pop-title">{pull.title}</span>
                <MergeButton
                  chain={chain}
                  pull={pull}
                  isArmed={isArmed}
                  waitForAllStatusChecks={waitForAllStatusChecks}
                  requireApproval={requireApproval}
                  requireResolvedThreads={requireResolvedThreads}
                  onMerge={mergePull}
                  onArm={armPull}
                />
                <button class="mn-copy-link" type="button" title="Copy PR link" aria-label="Copy PR link" onClick={(event) => copyLink(event, pull.url)}><CopyGlyph /></button>
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
                <button class="mn-copy-link" type="button" title="Copy issue link" aria-label="Copy issue link" onClick={(event) => copyLink(event, issue.url)}><CopyGlyph /></button>
              </div>
            )}
          </For>
          <For each={chain.runs.slice(0, 3)}>
            {(run) => {
              const relatedPull = pullForRun(run, chain.prs)
              return (
                <div class="mn-pop-row" onClick={() => { input.close(); open(run.url) }}>
                  <span class="mn-kind" data-state={run.status} title={ctx.t(`state.${run.status}`)}>
                    {runGlyph(run.status)}
                  </span>
                  <span class="mn-pop-id">#{run.id}</span>
                  <span class="mn-pop-title" title={relatedPull ? `${run.name} · associated with PR #${relatedPull.number}` : run.name}>
                    {run.name}{relatedPull ? ` · PR #${relatedPull.number}` : ""}
                  </span>
                  <button class="mn-copy-link" type="button" title="Copy run link" aria-label="Copy run link" onClick={(event) => copyLink(event, run.url)}><CopyGlyph /></button>
                </div>
              )
            }}
          </For>
          <Show when={chain.runs.length > 3}>
            <div
              class="mn-pop-more"
              onClick={() => {
                input.close()
                if (input.session?.id) ctx.layout.open(`${ctx.id}:history`, input.session)
              }}
            >
              +{chain.runs.length - 3} runs in the sidebar
            </div>
          </Show>
        </div>
  )

  // This chain's merge-when-ready toggle: binds to its own first open PR.
  // Shown in each slot's popover, next to the method select.
  const pillChainToggle = (chain: Chain): JSX.Element => (
    <Show when={menuLeadFor(chain)}>
      {(entry) => (
        <label
          class="mn-pop-toggle"
          title={
            isArmed(entry().pull)
              ? `Merging when ready (${entry().pull.autoMerge ? "also on the forge" : "watched locally"}); ${mergeReady(entry().chain, entry().pull, waitForAllStatusChecks(), requireApproval(), requireResolvedThreads()) ? "merging on the next check (within ~30s)" : `waiting: ${mergeWhy(entry().chain, entry().pull, waitForAllStatusChecks(), requireApproval(), requireResolvedThreads())}`} — click to stop`
              : mergeReady(entry().chain, entry().pull, waitForAllStatusChecks(), requireApproval(), requireResolvedThreads())
                ? "green now — Muninn merges on its next check (within ~30s)"
                : `Muninn merges once checks pass and merge requirements are satisfied — now blocked: ${mergeWhy(entry().chain, entry().pull, waitForAllStatusChecks(), requireApproval(), requireResolvedThreads())}`
          }
        >
          <input
            type="checkbox"
            checked={isArmed(entry().pull)}
            onChange={(event) => void armPull(entry().pull, event.currentTarget.checked)}
          />
          merge when ready
        </label>
      )}
    </Show>
  )

  // One chain's popover: the full chain picture with the merge controls the
  // sidebar has, plus the merge-method/delete-branch choices. Reads the stores
  // itself, so it stays live while open. Run ids live only here (pill grammar).
  // Pinning lives in the sidebar only: the dropdown shows a chain that is
  // already visible, so a pin row here would be noise.
  const pillMenuFor = (
    chain: Chain,
    input: ComposerPillMenuProps,
    extra?: JSX.Element,
  ): JSX.Element => {
    const lead = menuLeadFor(chain)
    return (
      <div class="mn-pop">
        {pillChainRows(chain, input)}
        <Show when={lead}>
          <div class="mn-pop-foot">
            <div class="mn-pop-line">
              {pillChainToggle(chain)}
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
            <label class="mn-pop-toggle">
              <input
                type="checkbox"
                checked={ctx.stores.settings.value.deleteBranch}
                onChange={(event) => ctx.stores.settings.update((draft) => { draft.deleteBranch = event.currentTarget.checked })}
              />
              delete tree + branch
            </label>
            <label class="mn-pop-toggle" title="Fetch and fast-forward only when the local base checkout is clean and can advance without a merge commit.">
              <input
                type="checkbox"
                checked={ctx.stores.settings.value.fastForwardBase}
                onChange={(event) => ctx.stores.settings.update((draft) => { draft.fastForwardBase = event.currentTarget.checked })}
              />
              fast-forward base branch
            </label>
          </div>
        </Show>
        {extra}
      </div>
    )
  }

  // One slot's popover: its own chain, live while open. Close-on-reorder:
  // the menu snapshots its chain key at open; a refresh that reorders picks
  // or drops the chain closes the popover instead of leaving the old chain's
  // merge controls under a newly assigned pill. Same-key refreshes (new entry
  // objects) stay open; the overflow count stays reactive while open.
  const SlotMenu = (props: { index: number; input: ComposerPillMenuProps }): JSX.Element => {
    const initial = visiblePicks()[props.index]?.chain.key
    createEffect(() => {
      const current = visiblePicks()[props.index]
      // Close when the slot reassigns or its pick merges (merged picks live
      // on the action-only contribution, which has no popover).
      if (!current || current.chain.key !== initial || pillLeadOf(current.chain, current.reason)?.state === "merged")
        props.input.close()
    })
    const entry = () => {
      const current = visiblePicks()[props.index]
      if (!current || pillLeadOf(current.chain, current.reason)?.state === "merged") return undefined
      return current
    }
    return (
      <Show when={entry()} fallback={<div class="mn-pop" />}>
        {(live) => {
          // Overflow has a visible host only on the last menu pill: trailing
          // merged picks render action-only capsules with no popover.
          const hostsOverflow = () => lastMenuIndex(visiblePicks()) === props.index
          return (
            <>
              {pillMenuFor(
                live().chain,
                props.input,
                hostsOverflow() && pillSlotOverflow() > 0 ? (
                  <div
                    class="mn-pop-more"
                    onClick={() => {
                      props.input.close()
                      if (props.input.session?.id) ctx.layout.open(`${ctx.id}:history`, props.input.session)
                    }}
                  >
                    {overflowLabel(pillSlotOverflow())}
                  </div>
                ) : undefined,
              )}
            </>
          )
        }}
      </Show>
    )
  }

  // Two contributions per pick slot: menu pills for live work and action-only
  // pills for merged picks (host-routed `run`, no popover). Each slot shows
  // at most one — the views are mutually exclusive on merged state — so the
  // row still holds one pill per pick in display order. The last menu slot
  // surfaces the overflow count; with zero menu pills the count survives only
  // in the last action pill's accessible title (explicitly accepted tradeoff).
  for (let slot = 0; slot < MAX_PILLS; slot++) {
    const index = slot
    ctx.add(ComposerPill, {
      id: `links-${index}`,
      order: 10 + index,
      show: (input) => {
        if (!input.session || input.session.id !== meta.sessionID) return undefined
        return pillSlotView(index)
      },
      menu: (input) => <SlotMenu index={index} input={input} />,
    })
    ctx.add(ComposerPill, {
      id: `links-${index}-merged`,
      order: 10 + index,
      show: (input) => {
        if (!input.session || input.session.id !== meta.sessionID) return undefined
        return mergedPillSlotView(index)
      },
    })
  }

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
            waitForAllStatusChecks={waitForAllStatusChecks}
            requireApproval={requireApproval}
            requireResolvedThreads={requireResolvedThreads}
            sessionReady={sessionReady}
            onOpen={open}
            onMerge={mergePull}
            onArm={armPull}
            isArmed={isArmed}
            isPinned={isPinned}
            onPin={togglePin}
          />
        </div>
        <Show when={chains().length === 0 && meta.repo === null && !sessionReady()}>
          <div class="mn-empty" />
        </Show>
      </div>
    ),
  })

  // ── Settings (app's Settings › Extensions area): caching, merging, decision models ──
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
        {
          id: "merge-method",
          title: ctx.t("settings.mergeMethod"),
          description: ctx.t("settings.mergeMethod.description"),
          keywords: "merge method squash rebase merge-commit how",
        },
        {
          id: "delete-branch",
          title: ctx.t("settings.deleteBranch"),
          description: ctx.t("settings.deleteBranch.description"),
          keywords: "merge delete branch tree worktree cleanup",
        },
        {
          id: "fast-forward-base",
          title: ctx.t("settings.fastForwardBase"),
          description: ctx.t("settings.fastForwardBase.description"),
          keywords: "merge fast-forward base checkout clean",
        },
        {
          id: "wait-for-all-status-checks",
          title: ctx.t("settings.waitForAllStatusChecks"),
          description: ctx.t("settings.waitForAllStatusChecks.description"),
          keywords: "merge checks status ci ready",
        },
        {
          id: "require-approval",
          title: ctx.t("settings.requireApproval"),
          description: ctx.t("settings.requireApproval.description"),
          keywords: "merge review approval approve changes requested comment reaction",
        },
        {
          id: "require-resolved-threads",
          title: ctx.t("settings.requireResolvedThreads"),
          description: ctx.t("settings.requireResolvedThreads.description"),
          keywords: "merge review unresolved threads conversations resolve outdated",
        },
        {
          id: "decision-models-enabled",
          title: ctx.t("settings.decisionModelsEnabled"),
          description: ctx.t("settings.decisionModelsEnabled.description"),
          keywords: "decision model judge filter candidate heuristic semantic",
        },
        {
          id: "candidate-provider-id",
          title: ctx.t("settings.candidateProviderID"),
          description: ctx.t("settings.candidateProviderID.description"),
          keywords: "decision model provider openai openrouter console google judge",
        },
        {
          id: "candidate-model",
          title: ctx.t("settings.candidateModel"),
          description: ctx.t("settings.candidateModel.description"),
          keywords: "decision model id pinned jev luna gemini validate",
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
  // Provider is a Select over the registry catalog plus live discovery, so
  // only complete valid providers ever persist — no draft needed. Unknown
  // stored values are preserved through the custom entry (hard transition
  // only dropped the legacy `candidateProvider` key, never new-key values).
  const [connectedProviders] = createResource(async () => {
    try {
      const out = await ctx.client.model.list({ types: ["decision"] }).catch(() => undefined)
      if (!out) return { ids: [] as string[], ok: false }
      return { ids: [...new Set(out.data.map((m) => m.providerID))], ok: true }
    } catch {
      return { ids: [] as string[], ok: false }
    }
  })
  const providerLabel = (id: string): string =>
    id === CUSTOM_PROVIDER
      ? ctx.t("settings.candidateProviderID.__custom")
      : decisionProviderIds().includes(id)
        ? ctx.t(`settings.candidateProviderID.${id}`)
        : decisionProviderLabel(id)
  const [customForced, setCustomForced] = createSignal(false)
  const picker = () =>
    mergeProviderOptions({
      catalogIds: decisionProviderIds(),
      discoveredIds: connectedProviders()?.ids ?? [],
      stored: (ctx.stores.settings.value.candidateProviderID ?? "").trim(),
      fallback: DEFAULT_DECISION_PROVIDER_ID,
      labels: providerLabel,
    })
  const selectedProviderID = (): string => {
    const merged = picker()
    return customForced() ? CUSTOM_PROVIDER : merged.selectValue
  }
  const showCustomInput = (): boolean => customForced() || picker().showCustomInput
  /** Raw provider for validation: the stored value verbatim, defaulted only
   * when blank. Never the "__custom" Select placeholder. */
  const validatedProviderID = (): string => (ctx.stores.settings.value.candidateProviderID ?? "").trim() || DEFAULT_DECISION_PROVIDER_ID
  // Model IDs are free text: commit trailing-edge debounced so typing never
  // wipes verdicts or re-arms the judge per keystroke. The timer is local to
  // this component and cleared on unmount.
  const [modelDraft, setModelDraft] = createSignal<string>(ctx.stores.settings.value.candidateModel ?? "")
  let modelCommit: ReturnType<typeof setTimeout> | undefined
  let committedModel = ctx.stores.settings.value.candidateModel ?? ""
  // Same debounce for the custom provider-ID input.
  const [customDraft, setCustomDraft] = createSignal<string>(
    (ctx.stores.settings.value.candidateProviderID ?? "").trim(),
  )
  let customCommit: ReturnType<typeof setTimeout> | undefined
  let committedCustom = (ctx.stores.settings.value.candidateProviderID ?? "").trim()
  onCleanup(() => {
    clearTimeout(modelCommit)
    clearTimeout(customCommit)
    modelEpoch++
  })
  createEffect(() => {
    // Tracks ONLY the store: keystrokes update the draft signals, which this
    // effect never reads, so typing can never retrigger it mid-word. Only a
    // genuine external write (another window) diverges from the last commit
    // and gets adopted.
    const current = ctx.stores.settings.value.candidateModel ?? ""
    if (current !== committedModel) {
      committedModel = current
      setModelDraft(current)
    }
    const currentProvider = (ctx.stores.settings.value.candidateProviderID ?? "").trim()
    if (currentProvider !== committedCustom) {
      committedCustom = currentProvider
      setCustomDraft(currentProvider)
      // An external write wins over a pending keystroke commit: cancel it
      // and reconcile custom mode with the adopted value.
      clearTimeout(customCommit)
      customCommit = undefined
      setCustomForced(false)
    }
  })
  // Live validation of the committed model ID: syntax is instant and local,
  // existence resolves server-side against OpenCode's registry for the
  // selected provider (listing + decision capability + known sets).
  // Unknown-but-well-formed IDs warn, never block: judging fails open.
  interface ModelCheck {
    status: "default" | "live" | "known" | "unverified" | "invalid" | "checking"
    message?: string
  }
  const blankNote = (providerID: string): { status: ModelCheck["status"]; message: string } => {
    const canonical = defaultModelForProvider(providerID)
    return canonical
      ? { status: "default", message: `Empty uses the provider default (${canonical}).` }
      : { status: "unverified", message: "No default for this provider — enter a model." }
  }
  const initialModelCheck = (): ModelCheck => {
    const providerID = validatedProviderID()
    const committed = (ctx.stores.settings.value.candidateModel ?? "").trim()
    if (!committed) return blankNote(providerID)
    const syntax = validateModelSyntax(committed)
    return syntax.ok ? { status: "checking" } : { status: "invalid", message: syntax.reason }
  }
  const [modelCheck, setModelCheck] = createSignal<ModelCheck>(initialModelCheck())
  let modelEpoch = 0
  createEffect(() => {
    const providerID = validatedProviderID()
    const committed = (ctx.stores.settings.value.candidateModel ?? "").trim()
    if (!committed) {
      modelEpoch++
      setModelCheck(blankNote(providerID))
      return
    }
    const syntax = validateModelSyntax(committed)
    if (!syntax.ok) {
      modelEpoch++
      setModelCheck({ status: "invalid", message: syntax.reason })
      return
    }
    const epoch = ++modelEpoch
    setModelCheck({ status: "checking" })
    void ctx.client
      .rpc(Muninn)
      .resolveModel({ providerID, model: committed })
      .then((result) => {
        if (epoch !== modelEpoch) return
        setModelCheck({
          status: result.status,
          ...(result.message ? { message: result.message } : {}),
        })
      })
      .catch(() => {
        if (epoch !== modelEpoch) return
        setModelCheck({
          status: "unverified",
          message: "Validation unreachable; judging will try it and fall back to heuristic on failure.",
        })
      })
  })
  const modelStatusLine = (): string => {
    const check = modelCheck()
    if (check.status === "checking") return ctx.t("settings.candidateModel.checking")
    return check.message ?? ""
  }

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
      <ui.SettingsSection title={ctx.t("settings.section.merging")}>
        <ui.SettingsRow
          id="merge-method"
          title={ctx.t("settings.mergeMethod")}
          description={ctx.t("settings.mergeMethod.description")}
        >
          <ui.Select
            label={ctx.t("settings.mergeMethod")}
            options={[
              { value: "squash", label: "squash" },
              { value: "merge", label: "merge commit" },
              { value: "rebase", label: "rebase" },
            ]}
            value={ctx.stores.settings.value.mergeMethod}
            onChange={(value) => {
              if (value === "squash" || value === "merge" || value === "rebase")
                ctx.stores.settings.update((draft) => { draft.mergeMethod = value })
            }}
          />
        </ui.SettingsRow>
        <ui.SettingsRow
          id="delete-branch"
          title={ctx.t("settings.deleteBranch")}
          description={ctx.t("settings.deleteBranch.description")}
        >
          <ui.Switch
            checked={ctx.stores.settings.value.deleteBranch}
            label={ctx.t("settings.deleteBranch")}
            hideLabel
            onChange={(checked) => ctx.stores.settings.update((draft) => { draft.deleteBranch = checked })}
          />
        </ui.SettingsRow>
        <ui.SettingsRow
          id="fast-forward-base"
          title={ctx.t("settings.fastForwardBase")}
          description={ctx.t("settings.fastForwardBase.description")}
        >
          <ui.Switch
            checked={ctx.stores.settings.value.fastForwardBase === true}
            label={ctx.t("settings.fastForwardBase")}
            hideLabel
            onChange={(checked) => ctx.stores.settings.update((draft) => { draft.fastForwardBase = checked })}
          />
        </ui.SettingsRow>
        <ui.SettingsRow
          id="wait-for-all-status-checks"
          title={ctx.t("settings.waitForAllStatusChecks")}
          description={ctx.t("settings.waitForAllStatusChecks.description")}
        >
          <ui.Switch
            checked={ctx.stores.settings.value.waitForAllStatusChecks !== false}
            label={ctx.t("settings.waitForAllStatusChecks")}
            hideLabel
            onChange={(checked) => ctx.stores.settings.update((draft) => { draft.waitForAllStatusChecks = checked })}
          />
        </ui.SettingsRow>
        <ui.SettingsRow
          id="require-approval"
          title={ctx.t("settings.requireApproval")}
          description={ctx.t("settings.requireApproval.description")}
        >
          <ui.Switch
            checked={ctx.stores.settings.value.requireApproval === true}
            label={ctx.t("settings.requireApproval")}
            hideLabel
            onChange={(checked) => ctx.stores.settings.update((draft) => { draft.requireApproval = checked })}
          />
        </ui.SettingsRow>
        <ui.SettingsRow
          id="require-resolved-threads"
          title={ctx.t("settings.requireResolvedThreads")}
          description={ctx.t("settings.requireResolvedThreads.description")}
        >
          <ui.Switch
            checked={ctx.stores.settings.value.requireResolvedThreads === true}
            label={ctx.t("settings.requireResolvedThreads")}
            hideLabel
            onChange={(checked) => ctx.stores.settings.update((draft) => { draft.requireResolvedThreads = checked })}
          />
        </ui.SettingsRow>
      </ui.SettingsSection>
      <ui.SettingsSection title={ctx.t("settings.section.decisionModels")}>
        <ui.SettingsRow
          id="decision-models-enabled"
          title={ctx.t("settings.decisionModelsEnabled")}
          description={ctx.t("settings.decisionModelsEnabled.description")}
        >
          <ui.Switch
            checked={ctx.stores.settings.value.decisionModelsEnabled === true}
            label={ctx.t("settings.decisionModelsEnabled")}
            hideLabel
            onChange={(checked) => ctx.stores.settings.update((draft) => { draft.decisionModelsEnabled = checked })}
          />
        </ui.SettingsRow>
        <ui.SettingsRow
          id="candidate-provider-id"
          title={ctx.t("settings.candidateProviderID")}
          description={ctx.t("settings.candidateProviderID.description")}
        >
          <div style={{ display: "flex", "flex-direction": "column", gap: "4px", "align-items": "flex-end" }}>
            <ui.Select
              label={ctx.t("settings.candidateProviderID")}
              options={picker().options}
              value={selectedProviderID()}
              onChange={(value) => {
                if (value === CUSTOM_PROVIDER) {
                  setCustomForced(true)
                  return
                }
                // A newer selection cancels any pending custom commit.
                clearTimeout(customCommit)
                customCommit = undefined
                const knownIds = picker()
                  .options.filter((o) => o.value !== CUSTOM_PROVIDER)
                  .map((o) => o.value)
                const applied = resolveCustomCommit(value, knownIds)
                committedCustom = applied.store ?? ""
                setCustomDraft(applied.store ?? "")
                setCustomForced(applied.forced)
                ctx.stores.settings.update((draft) => { draft.candidateProviderID = applied.store })
              }}
            />
            <Show when={connectedProviders.loading}>
              <span class="mn-note" style={{ padding: "0 4px" }}>Checking connected providers…</span>
            </Show>
            <Show when={!connectedProviders.loading && connectedProviders()?.ok === false}>
              <span class="mn-note" style={{ padding: "0 4px" }} data-warn="">
                Couldn't reach connected providers; showing known providers.
              </span>
            </Show>
            <Show when={showCustomInput()}>
              <ui.TextInput
                value={customDraft()}
                label={ctx.t("settings.candidateProviderID")}
                onInput={(value) => {
                  setCustomDraft(value)
                  clearTimeout(customCommit)
                  customCommit = setTimeout(() => {
                    customCommit = undefined
                    const knownIds = picker()
                      .options.filter((o) => o.value !== CUSTOM_PROVIDER)
                      .map((o) => o.value)
                    const applied = resolveCustomCommit(value, knownIds)
                    committedCustom = applied.store ?? ""
                    setCustomDraft(applied.store ?? "")
                    setCustomForced(applied.forced)
                    ctx.stores.settings.update((draft) => { draft.candidateProviderID = applied.store })
                  }, 500)
                }}
              />
            </Show>
          </div>
        </ui.SettingsRow>
        <ui.SettingsRow
          id="candidate-model"
          title={ctx.t("settings.candidateModel")}
          description={ctx.t("settings.candidateModel.description")}
        >
          <div style={{ display: "flex", "flex-direction": "column", gap: "4px", "align-items": "flex-end" }}>
            <ui.TextInput
              value={modelDraft()}
              label={ctx.t("settings.candidateModel")}
              placeholder={defaultModelForProvider(validatedProviderID()) ?? ""}
              invalid={modelCheck().status === "invalid"}
              onInput={(value) => {
                setModelDraft(value)
                clearTimeout(modelCommit)
                modelCommit = setTimeout(() => {
                  modelCommit = undefined
                  const v = value.trim()
                  committedModel = v
                  ctx.stores.settings.update((draft) => { draft.candidateModel = v || undefined })
                }, 500)
              }}
            />
            {modelCheck().status !== "default" && (
              <span
                class="mn-note"
                style={{ padding: "0 4px" }}
                data-warn={modelCheck().status === "invalid" || modelCheck().status === "unverified" ? "" : undefined}
              >
                {modelStatusLine()}
              </span>
            )}
          </div>
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
.mn-mark.mn-link { cursor: pointer; }
.mn-mark.mn-link:hover { color: var(--v2-text-text-accent); }
.mn-title[data-toggle] { cursor: pointer; }
.mn-row[data-toggle] { cursor: pointer; }
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
.mn-kind { flex: none; display: inline-flex; }
.mn-kind[data-state="issue-open"], .mn-kind[data-state="pr-open"] { color: var(--v2-state-fg-success); }
.mn-kind[data-state="pr-draft"] { color: var(--v2-icon-icon-faint); }
.mn-kind[data-state="pr-merged"] { color: #8250df; }
.mn-kind[data-state="issue-closed"] { color: var(--v2-text-text-accent); }
.mn-chain[data-tone="warning"] .mn-kind[data-state="pr-merged"], .mn-pop-chain[data-tone="warning"] .mn-kind[data-state="pr-merged"] { color: var(--v2-state-fg-warning); }
.mn-chain[data-tone="danger"] .mn-kind[data-state="pr-merged"], .mn-pop-chain[data-tone="danger"] .mn-kind[data-state="pr-merged"] { color: var(--v2-state-fg-danger); }
.mn-kind[data-state="pr-closed"] { color: var(--v2-state-fg-danger); }
.mn-kind[data-state="pr-conflict"] { color: var(--v2-state-fg-danger, #cf222e); }
.mn-id { font-family: var(--v2-font-family-code); font-size: 11.5px; font-weight: 600; flex: none; cursor: copy; }
.mn-id.copied { color: var(--v2-state-fg-success); }
.mn-chain[data-stale="true"] { opacity: .55; }
.mn-title { flex: 1; min-width: 0; font-size: 12px; color: var(--v2-text-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mn-pin {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 0; height: 22px; min-width: 0; margin: -4px -8px -4px 0; border: 0; border-radius: 6px; padding: 0;
  overflow: hidden; opacity: 0; pointer-events: none;
  background: transparent; color: var(--v2-text-text-faint); cursor: pointer;
}
/* Collapsed to zero width (the -8px right margin cancels its flex gap) until
 * the row is hovered or the pin itself is focused: rendered-but-invisible
 * stays keyboard-focusable, unlike display: none — and still reserves no
 * space either way. */
.mn-row:hover .mn-pin, .mn-pin:focus-visible, .mn-pin[data-pinned="true"] {
  width: 22px; margin: -4px 0; opacity: 1; pointer-events: auto;
}
.mn-pin:hover { background: var(--v2-overlay-simple-overlay-hover); color: var(--v2-text-text-base); }
.mn-pin:focus-visible { outline: 1px solid var(--v2-state-fg-warning, #9a6700); }
.mn-pin[data-pinned="true"] { color: var(--v2-text-text-accent, #0969da); }
.mn-meta { flex: none; font-size: 10.5px; color: var(--v2-text-text-faint); font-family: var(--v2-font-family-code); }
.mn-state { display: inline-flex; align-items: center; gap: 4px; flex: none; font-size: 10.5px; font-family: var(--v2-font-family-code); }
.mn-state[data-state="open"], .mn-state[data-status="succeeded"] { color: var(--v2-state-fg-success); }
.mn-state[data-state="merged"] { color: #8250df; }
.mn-state[data-state="closed"], .mn-state[data-status="running"] { color: var(--v2-text-text-accent); }
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
/* Accordion sections: one per PR group so long lists fit without cutoff.
 * First section open by default; the rest expand in place. Native details
 * keeps keyboard semantics; the caret rotates when open. */
.mn-acc { border-radius: 8px; box-shadow: inset 0 0 0 .5px var(--v2-border-border-muted); overflow: hidden; flex: none; }
.mn-acc + .mn-acc { margin-top: 4px; }
.mn-acc[data-tone="danger"] { box-shadow: inset 0 0 0 .5px var(--v2-state-border-danger); }
.mn-acc-head { display: flex; align-items: center; gap: 7px; padding: 7px 10px; cursor: pointer; list-style: none; min-width: 0; font-size: 11.5px; }
.mn-acc-head::-webkit-details-marker { display: none; }
.mn-acc-head:hover { background: var(--v2-overlay-simple-overlay-hover); }
.mn-acc-caret { flex: none; font-size: 10px; color: var(--v2-text-text-faint); transition: transform .15s ease; }
.mn-acc[open] .mn-acc-caret { transform: rotate(90deg); }
.mn-acc-dot { flex: none; font-size: 9px; line-height: 1; }
.mn-acc-dot[data-tone="success"] { color: var(--v2-state-fg-success, #1a7f37); }
.mn-acc-dot[data-tone="warning"] { color: var(--v2-state-fg-warning, #9a6700); }
.mn-acc-dot[data-tone="danger"] { color: var(--v2-state-fg-danger, #cf222e); }
.mn-acc-title { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: var(--v2-font-family-code); color: var(--v2-text-text-base); }
.mn-acc-pin { flex: none; font-size: 10.5px; color: var(--v2-text-text-faint); }
.mn-acc-body { padding: 2px 2px 4px; border-top: 1px solid var(--v2-border-border-muted); }
.mn-pop-chain { display: flex; flex-direction: column; gap: 1px; }
.mn-pop-chain + .mn-pop-chain { margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--v2-border-border-muted); }
.mn-pop-row { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 7px; font-size: 12px; min-width: 0; }
.mn-pop-row:hover { background: var(--v2-overlay-simple-overlay-hover); cursor: pointer; }
.mn-copy-link { flex: none; border: 0; border-radius: 4px; padding: 2px 5px; background: transparent; color: var(--v2-text-text-muted); font: inherit; font-size: 10px; cursor: pointer; }
.mn-copy-link:hover { background: var(--v2-overlay-simple-overlay-hover); color: var(--v2-text-text-base); }
.mn-pop-id { font-family: var(--v2-font-family-code); font-size: 11px; color: var(--v2-text-text-muted); flex: none; }
.mn-pop-title { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--v2-text-text-base); }
.mn-pop-more { padding: 4px 8px; font-size: 11px; color: var(--v2-text-text-faint); cursor: pointer; border-radius: 7px; }
.mn-pop-more:hover { background: var(--v2-overlay-simple-overlay-hover); color: var(--v2-text-text-muted); }
.mn-pop-label { padding: 4px 8px 4px 0; font-size: 11px; color: var(--v2-text-text-faint); }
.mn-pop-foot {
  display: flex; flex-direction: column; align-items: stretch; gap: 7px;
  margin-top: 4px; padding: 8px 8px 4px;
  border-top: 1px solid var(--v2-border-border-muted);
  font-size: 11px; color: var(--v2-text-text-faint);
}
.mn-pop-toggle { display: flex; align-items: center; gap: 6px; cursor: pointer; min-width: 0; }
.mn-pop-toggle:has(input:disabled) { cursor: not-allowed; opacity: .55; }
.mn-pop-line { display: flex; align-items: center; gap: 8px; min-width: 0; }
.mn-pop-line .mn-pop-toggle { flex: 1; }
.mn-pop-foot select {
  margin-left: auto; flex: none; width: auto; font-size: 11px; color: var(--v2-text-text-muted);
  background: var(--v2-background-bg-layer-01); border: 1px solid var(--v2-border-border-muted);
  border-radius: 5px; padding: 3px 6px;
}
.mn-kind { color: var(--v2-icon-icon-muted); flex: none; display: inline-flex; }
.mn-kind[data-state="open"], .mn-kind[data-state="succeeded"] { color: var(--v2-state-fg-success); }
.mn-kind[data-state="draft"], .mn-kind[data-state="queued"], .mn-kind[data-state="running"] { color: var(--v2-state-fg-warning); }
.mn-kind[data-state="merged"] { color: #8250df; }
.mn-kind[data-state="closed"], .mn-kind[data-state="failed"], .mn-kind[data-state="cancelled"] { color: var(--v2-state-fg-danger); }

/* Merge action: green when ready, amber while checks run, grey when blocked.
 * Both halves of each pair are owned here: the host's --v2-state-bg-success
 * can be a light green without a matching on-color, which stranded white
 * text on a light background. These stay legible in both schemes. */
.mn-merge {
  flex: none; font-size: 10.5px; font-weight: 600; line-height: 1;
  padding: 4px 9px; border-radius: 6px; cursor: pointer;
  color: #fff;
  background: #1f883d; border: none;
  outline: none; box-shadow: none;
}
.mn-merge:focus { outline: none; box-shadow: none; }
.mn-merge:focus-visible { outline: 1px solid var(--v2-state-fg-warning, #9a6700); outline-offset: 1px; box-shadow: none; }
@media (prefers-color-scheme: dark) {
  .mn-merge { background: #238636; }
}
.mn-merge:hover { filter: brightness(1.1); }
.mn-merge.failed:disabled { opacity: .65; cursor: not-allowed; filter: none; pointer-events: none; }
/* Wrapper is the real pointer target: the disabled button is click-through,
 * so tooltip, row-click suppression, and cursor all live here. */
.mn-wrap-fail { display: inline-flex; flex: none; cursor: not-allowed; }
.mn-merge.pending {
  background: #9a6700;
  color: #fff;
}
.mn-merge.failed {
  background: #cf222e;
  color: #fff;
}
@media (prefers-color-scheme: dark) {
  .mn-merge.failed { background: #da3633; }
}
.mn-merge.armed {
  background: none; color: var(--v2-state-fg-warning, #9a6700);
  box-shadow: inset 0 0 0 .5px var(--v2-state-border-warning, #9a6700);
  display: inline-flex; align-items: center; gap: 5px;
}
.mn-merge.armed:hover { background: var(--v2-overlay-simple-overlay-hover); filter: none; }
.mn-merge.armed.ready { color: var(--v2-state-fg-success, #1a7f37); box-shadow: inset 0 0 0 .5px var(--v2-state-fg-success, #1a7f37); }
.mn-merge.armed.failed { color: #cf222e; box-shadow: inset 0 0 0 .5px #cf222e; }
@media (prefers-color-scheme: dark) {
  .mn-merge.armed.failed { color: #f47067; box-shadow: inset 0 0 0 .5px #f47067; }
}
.mn-merge.armed.ready .mn-spin { color: var(--v2-state-fg-success, #1a7f37); box-shadow: inset 0 0 0 .5px var(--v2-state-fg-success, #1a7f37); background: none; }
.mn-merge.armed.failed .mn-spin { color: #cf222e; box-shadow: inset 0 0 0 .5px #cf222e; background: none; }
.mn-merge.armed .mn-spin {
  background: none; color: var(--v2-state-fg-warning, #9a6700);
  box-shadow: inset 0 0 0 .5px var(--v2-state-border-warning, #9a6700);
  width: 9px; height: 9px; border: 1px solid transparent;
  border-top-color: currentColor; border-left-color: currentColor;
  animation-duration: 1.1s;
}

/* Merge-status glyph: GitHub's circle-dot, colored by merge state. Unknown
 * (no mergeability yet) is in-flight amber — never the muted default, which
 * renders as black and matches no status color. Conflict is danger. */
.mn-merge-state { color: var(--v2-icon-icon-muted); flex: none; display: inline-flex; }
.mn-merge-state[data-state="ready"] { color: var(--v2-state-fg-success, #1a7f37); }
.mn-merge-state[data-state="pending"] { color: var(--v2-state-fg-warning, #9a6700); }
.mn-merge-state[data-state="blocked"] { color: var(--v2-state-fg-danger, #cf222e); }
.mn-merge-state[data-state="unknown"] { color: var(--v2-state-fg-warning, #9a6700); }
.mn-merge-state[data-state="conflict"] { color: var(--v2-state-fg-danger, #cf222e); }
.mn-merge-state[data-state="merged"] { color: #8250df; }
/* GitHub's merged purple needs its dark-mode pair. Placed after every merged
 * light declaration so it wins those ties; the armed rule below stays last so
 * the watching-pulse keeps precedence, and warning/danger chain tones win by
 * higher specificity anywhere. */
@media (prefers-color-scheme: dark) {
  .mn-kind[data-state="pr-merged"], .mn-kind[data-state="merged"], .mn-merge-state[data-state="merged"], .mn-state[data-state="merged"] { color: #a371f7; }
}
/* Armed: Muninn is watching — the dot pulses until the merge fires. */
.mn-merge-state[data-armed] { color: var(--v2-state-fg-warning, #9a6700); animation: mn-pulse 1.6s ease-in-out infinite; }
@keyframes mn-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }

/* Merged action pills: hover swaps the green branch for an active pin whose
 * click unpins/dismisses via the contribution's host-routed \`run\` (no popover,
 * no capture interception). The \`.mn-merged-unpin\` marker is applied by JS
 * only to verified owned capsules (exact label + title match, fail closed),
 * never by accessible-text substring — an open PR titled \`· merged\` restyles
 * nothing. The icon box is fixed at 14px in both states so the swap never
 * resizes the capsule; the label is identical either way, so pill width holds. */
button[data-slot="session-plugin-pill"].mn-merged-unpin > svg[data-slot="icon-svg"] {
  width: 14px; height: 14px; flex: none;
}
@media (hover: hover) {
  button[data-slot="session-plugin-pill"].mn-merged-unpin:hover > svg[data-slot="icon-svg"] {
    display: none;
  }
  button[data-slot="session-plugin-pill"].mn-merged-unpin:hover::before {
    content: "";
    width: 14px; height: 14px; flex: none;
    background-color: var(--v2-text-text-accent, #0969da);
    -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='m11.294.984 3.722 3.722a1.75 1.75 0 0 1-.504 2.826l-1.327.613a3.089 3.089 0 0 0-1.707 2.084l-.584 2.454c-.317 1.332-1.972 1.8-2.94.832L5.75 11.311 1.78 15.28a.749.749 0 1 1-1.06-1.06l3.969-3.97-2.204-2.204c-.968-.968-.5-2.623.832-2.94l2.454-.584a3.08 3.08 0 0 0 2.084-1.707l.613-1.327a1.75 1.75 0 0 1 2.826-.504Z'/%3E%3C/svg%3E");
    mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='m11.294.984 3.722 3.722a1.75 1.75 0 0 1-.504 2.826l-1.327.613a3.089 3.089 0 0 0-1.707 2.084l-.584 2.454c-.317 1.332-1.972 1.8-2.94.832L5.75 11.311 1.78 15.28a.749.749 0 1 1-1.06-1.06l3.969-3.97-2.204-2.204c-.968-.968-.5-2.623.832-2.94l2.454-.584a3.08 3.08 0 0 0 2.084-1.707l.613-1.327a1.75 1.75 0 0 1 2.826-.504Z'/%3E%3C/svg%3E");
    -webkit-mask-size: contain; mask-size: contain;
    -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat;
    -webkit-mask-position: center; mask-position: center;
  }
}
/* Keyboard focus shows the same pin so the unpin target stays discoverable. */
button[data-slot="session-plugin-pill"].mn-merged-unpin:focus-visible > svg[data-slot="icon-svg"] {
  display: none;
}
button[data-slot="session-plugin-pill"].mn-merged-unpin:focus-visible::before {
  content: "";
  width: 14px; height: 14px; flex: none;
  background-color: var(--v2-text-text-accent, #0969da);
  -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='m11.294.984 3.722 3.722a1.75 1.75 0 0 1-.504 2.826l-1.327.613a3.089 3.089 0 0 0-1.707 2.084l-.584 2.454c-.317 1.332-1.972 1.8-2.94.832L5.75 11.311 1.78 15.28a.749.749 0 1 1-1.06-1.06l3.969-3.97-2.204-2.204c-.968-.968-.5-2.623.832-2.94l2.454-.584a3.08 3.08 0 0 0 2.084-1.707l.613-1.327a1.75 1.75 0 0 1 2.826-.504Z'/%3E%3C/svg%3E");
  mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='m11.294.984 3.722 3.722a1.75 1.75 0 0 1-.504 2.826l-1.327.613a3.089 3.089 0 0 0-1.707 2.084l-.584 2.454c-.317 1.332-1.972 1.8-2.94.832L5.75 11.311 1.78 15.28a.749.749 0 1 1-1.06-1.06l3.969-3.97-2.204-2.204c-.968-.968-.5-2.623.832-2.94l2.454-.584a3.08 3.08 0 0 0 2.084-1.707l.613-1.327a1.75 1.75 0 0 1 2.826-.504Z'/%3E%3C/svg%3E");
  -webkit-mask-size: contain; mask-size: contain;
  -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat;
  -webkit-mask-position: center; mask-position: center;
}
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
