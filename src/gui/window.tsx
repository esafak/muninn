import { createEffect, createMemo, createSignal, onCleanup, untrack, For, Show } from "solid-js"
import type { JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { ComposerPill, MenuItem, Panel, SettingsPage, createKeyed, usePlugin, type IconName, type Plugin } from "@opencode/plugin/gui"
import { associate } from "../associate"
import { messageBuckets, wireRefs } from "../extract"
import type { TieredRef } from "../extract"
import { heuristicExtract } from "../candidates/heuristic"
import { bareKindKept, bareSurvives } from "../candidates/filtering"
import { isDecisionBackend } from "../candidates/types"
import type { ArmedEntry, Chain, Entity, Pin, PullEntity, RepoRef, RunEntity, RunStatus } from "../model"
import { chainTone, armedTargets, staleHeadRetryEligible, staleHeadEvidenceUsable, sessionAttemptCurrent, targetRefreshConfirmed, pillPick, pillEligible, pinnedChain, pinForChain, isFreshBaseSession, mergeReady, mergeWhy, pendingReviewNotice, latestRun, pullForRun, prConflicted, refKey, repoKey, entityKey } from "../model"
import { githubLexicon } from "../providers/github/lexicon"
import { baseCheckoutDecision, cleanFromCheck, cleanupDecision, cleanupResultMessage, cleanupSessionMatches, locateCheckout, safeFastForward, sessionMoveConfirmed, shouldFastForwardBase, shouldRecordCleanupFailure, worktreeOccupancyDecision } from "../local-cleanup"
import type { CheckoutKind } from "../local-cleanup"
import { Muninn } from "../rpc"
import type { definition } from "./definition"
import { History, MergeButton } from "./history"
import { CancelledGlyph, CheckGlyph, CopyGlyph, CrossGlyph, IssueGlyph, MergeGlyph, MergedGlyph, PullConflictGlyph, PullGlyph, QueuedGlyph, UnknownGlyph } from "./icons"
import { pillIcon } from "./marks"
import { pillStatusIcon, pillStatusTone } from "./pill-status"
import { pillPullDiagnostics } from "./pill-diagnostics"

const POLL_MS = 30_000
/** Debounce for scan → hydrate while a message streams in. */
const HYDRATE_DEBOUNCE_MS = 600
/** How long a forge-reported merge blocks retries while hydration catches up.
 * Matches the server dedupe TTL: long enough to collapse double-fires across
 * windows, short enough that an open-after-merged (eventual consistency)
 * retries without a restart. */
const MERGE_CONFIRM_GRACE_MS = 60_000

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

  /** One extraction: refs plus their evidence snippets. A single scan feeds
   * both the tiers and the judge — the two never diverge. */
  const extracted = createMemo(() =>
    heuristicExtract(buckets(), meta.repo ?? undefined, [githubLexicon], (ctx.stores.settings.value.candidateProvider ?? "heuristic") === "heuristic" ? "strict" : "permissive"),
  )
  const refs = () => extracted().refs

  /** Snippets for the DecisionModel: first bucket string (+command) per ref. */
  const snippets = () => extracted().snippets

  /**
   * Per-ref keep/drop verdicts, scoped to the session + directory + provider +
   * model that produced them. `undefined` (or a scope mismatch) means heuristic
   * keep-all: verdicts never leak across sessions, models, or provider switches.
   */
  interface JudgeVerdicts {
    sessionID: string
    directory: string
    provider: string
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
  const candidateProvider = () => ctx.stores.settings.value.candidateProvider ?? "heuristic"
  const candidateModel = () => ctx.stores.settings.value.candidateModel
  // Stale verdicts never apply across provider switches. Track ONLY the
  // provider/model here: rechain() reads verdicts, so running it tracked
  // would make every committed judgment immediately wipe itself.
  createEffect(() => {
    candidateProvider()
    candidateModel()
    untrack(() => {
      setVerdicts(undefined)
      rechain()
    })
  })

  /** Verdicts only when they belong to this session, directory, provider, and model. */
  const verdictsForSession = (): Map<string, boolean> | undefined => {
    const v = verdicts()
    const current = session()
    if (!v || !current || v.sessionID !== current.id || v.directory !== current.directory) return undefined
    if (v.provider !== candidateProvider()) return undefined
    if ((v.model ?? undefined) !== (candidateModel() ?? undefined)) return undefined
    return v.kept
  }

  /** Refs after the DecisionModel filter; heuristic mode returns refs unchanged.
   * Bare-ref survival is judged over ACTUAL hydrated kinds (`bareSurvives`):
   * all-explicit-drops drops, anything unanswered fails open — so a sliced-off
   * kind can never silently kill its bare ref. */
  const filteredRefs = createMemo(() => {
    if (candidateProvider() === "heuristic") return refs()
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
    if (isFreshBaseSession(meta.branch, refs().length)) {
      setChains([])
      return
    }
    setChains(associate([...relevant, ...related], repo ? (runs[repoKey(repo)] ?? []) : []))
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
   * - Verdicts are scoped to session + directory + provider + model; a
   *   response that arrives after any of those changed is discarded. RPC
   *   failure clears same-scope verdicts (fail-open keep-all) under the
   *   same guard instead of retaining stale drops. */
  const judgeFound = async (
    sessionID: string,
    directory: string,
    foundRefs: readonly TieredRef[],
    epoch: number,
  ): Promise<void> => {
    const provider = candidateProvider()
    if (provider === "heuristic" || foundRefs.length === 0) return
    if (epoch !== judgeEpoch) return
    const judgedModel = candidateModel()
    const fresh = (): boolean => {
      const live = session()
      return epoch === judgeEpoch && !!live && live.id === sessionID && live.directory === directory &&
        candidateProvider() === provider && (candidateModel() ?? undefined) === (judgedModel ?? undefined)
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
        .judge({ directory, provider, ...(judgedModel ? { model: judgedModel } : {}), candidates })
        .catch(() => undefined)
      // Commit or clear under the same freshness guard: a stale success must
      // not overwrite newer verdicts, and a failure must not retain stale drops.
      if (!fresh()) return
      if (judged)
        setVerdicts({ sessionID, directory, provider, ...(judgedModel ? { model: judgedModel } : {}), kept: new Map(judged.verdicts.map((v) => [v.key, v.keep])) })
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

  /** Re-reads repository coordinates, then hydrates and re-chains. Cheap when cached. */
  const refresh = async (target?: { repo: RepoRef; number: number }): Promise<boolean> => {
    const current = session()
    if (!current) return false
    const generation = ++refreshGeneration
    // Operation epoch shared with the message debounce: whichever pipeline
    // starts last owns the next judgment. Captured before any network I/O so
    // a slow refresh can never overwrite a newer debounce judgment.
    const epoch = ++judgeEpoch
    const currentRefresh = () =>
      generation === refreshGeneration && sessionAttemptCurrent(current, session())
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
        const requested = [
          ...found,
          ...recoveryTargets.map((entry) => ({
            repo: entry.repo,
            number: entry.number,
            kind: "pr" as const,
            tier: "user" as const,
          })),
        ]
        let targetPull: PullEntity | undefined
        let targetUnresolved = false
        if (requested.length > 0) {
          const wire = wireRefs(requested)
          const result = await stage("hydrate", () => client.rpc(Muninn).hydrate({ directory: current.directory, refs: wire.refs }))
          if (!currentRefresh()) {
            resumeInFlightBranch = undefined
            return false
          }
          merge(result.entities)
          for (const pull of result.entities.filter((entity): entity is PullEntity => entity.kind === "pr")) {
            const key = mergeKey(pull.repo, pull.number)
            if (recoveryKeys.has(key)) recoveredPulls.set(key, pull)
          }
          targetPull = result.entities.find(
            (entity): entity is PullEntity => entity.kind === "pr" && targetKey === mergeKey(entity.repo, entity.number),
          )
          targetUnresolved = !!target && result.unresolved.some(
            (ref) => ref.number === target.number && ref.repo !== undefined && repoKey(ref.repo) === repoKey(target.repo),
          )
          setMeta("unresolved", result.unresolved.length)
          const byKind = new Map<string, number>()
          for (const entity of result.entities) byKind.set(entity.kind, (byKind.get(entity.kind) ?? 0) + 1)
          const breakdown = [...byKind].map(([kind, count]) => `${count} ${kind}`).join(", ") || "none"
          const sent = wire.capped || wire.dropped > 0 ? `${wire.refs.length}/${requested.length}` : `${wire.refs.length}`
          const dropped = wire.dropped > 0 ? ` · ${wire.dropped} invalid dropped` : ""
          const unresolved = result.unresolved.length > 0 ? ` · ${result.unresolved.length} unresolved (${unresolvedLabel(result.unresolved, repo)})` : ` · ${result.unresolved.length} unresolved`
          setMeta("stats", `${sent} refs → ${result.entities.length} hydrated (${breakdown})${unresolved}${dropped}`)
        }
        if (branch && !isFreshBaseSession(branch ?? "", found.length)) {
          const { runs: branchRuns, prs } = await stage("branch-runs", () => client.rpc(Muninn).branchRuns({ directory: current.directory, branch }))
          if (!currentRefresh()) {
            resumeInFlightBranch = undefined
            return false
          }
          setRuns(repoKey(repo), branchRuns)
          branchRunsBranch = branch
          if (resumeInFlightBranch === branch) resumeInFlightBranch = undefined
          merge(prs)
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
        if (!currentRefresh()) {
          resumeInFlightBranch = undefined
          return false
        }
        for (const [key, pull] of recoveredPulls) refreshedPullByPR.set(key, pull)
        setMeta("error", null)
        await judgeFound(current.id, current.directory, found, epoch)
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
        resumeInFlightBranch = undefined
        setMeta("error", error instanceof Error ? error.message : String(error))
        return false
      }
    })()

    const dbg = await client.rpc(Muninn).debug({}).catch(() => null)
    setMeta("debug", dbg ? `srv ${dbg.server}` : "srv ?")
    if (!currentRefresh()) return false
    return refreshed
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
      // Verdicts belong to the session that produced them; never carry over.
      setVerdicts(undefined)
      setSessionReady(false)
      branchRunsBranch = undefined
      resumePendingBranch = undefined
      resumeInFlightBranch = undefined
      branchLoaded = false
      void refresh()
    },
  )

  // Messages changed re-hydrates after a short debounce, so streaming text settles.
  // Provider/model changes re-judge through the same path: the effect tracks
  // them, so a settled model switch schedules exactly one judgment.
  let timer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    const found = refs()
    const provider = candidateProvider()
    const model = candidateModel()
    void provider
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
    if (!meta.repo || found.length === 0) return
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
        void refresh()
      }, HYDRATE_DEBOUNCE_MS)
      return
    }
    const generationAtSchedule = refreshGeneration
    timer = setTimeout(() => {
      timer = undefined
      if (generationAtSchedule !== refreshGeneration) return
      if (isFreshBaseSession(meta.branch, refs().length)) return
      const current = session()
      if (!current) return
      // Same shared epoch: a debounce that fires later wins over an older refresh.
      const epoch = ++judgeEpoch
      const wire = wireRefs(refs())
      void ctx.client
        .rpc(Muninn)
        .hydrate({ directory: current.directory, refs: wire.refs })
        .then(async ({ entities: hydrated, unresolved }) => {
          if (generationAtSchedule !== refreshGeneration) return
          // Reject stale callbacks before touching shared state: a session that
          // moved directories must not merge the old directory's entities.
          if (!sessionAttemptCurrent(current, session())) return
          if (isFreshBaseSession(meta.branch, refs().length)) return
          merge(hydrated)
          setMeta("unresolved", unresolved.length)
          // Same policy as refresh: judge before chaining, so the message
          // path never bypasses model filtering.
          await judgeFound(current.id, current.directory, refs(), epoch)
          rechain()
        })
        .catch(() => undefined)
    }, HYDRATE_DEBOUNCE_MS)
  })

  // CI state changes upstream: poll while this session has anything to show.
  // Branch moves off base must also leave the fresh state without restart.
  const poll = setInterval(() => {
    const current = session()
    if (!current) return
    void ctx.client.vcs
      .get({ location: { directory: current.directory } })
      .then((vcs) => {
        const branch = vcs?.data?.branch?.current ?? ""
        if (branch !== meta.branch && (meta.branch !== "" || branchLoaded)) void refresh()
        else if (chains().length > 0) void refresh()
      })
      .catch(() => {
        if (chains().length > 0) void refresh()
      })
  }, POLL_MS)
  onCleanup(() => {
    clearInterval(poll)
    clearTimeout(timer)
  })

  // ── Component 1: pills above the composer ────────────────────────────────
  // One eligibility policy, one memo, three consumers (`show`, `menu`,
  // `debugLine`) — the same values everywhere, with no per-consumer filter for
  // the footer's census to drift away from (the failure mode the old
  // `live()`-counts-vs-`pillChains()`-pick split already produced). State-driven
  // via `pillEligible`: the session's own PR (still shown after it merges — the
  // pill is the session's work, and a newer PR outranks it through `pillPick`),
  // CI needing attention, an armed merge pending. Mentions of other branches'
  // work stay in the sidebar; settled history never pills.
  // Provider draft: TextInput is free-form, so intermediate keystrokes must not
  // normalize the stored setting (typing "openrouter" letter by letter would
  // otherwise persist "heuristic" on every prefix). Draft locally, persist
  // only complete valid backend names.

  const waitForAllStatusChecks = () => ctx.stores.settings.value.waitForAllStatusChecks !== false
  const pillState = createMemo(() => {
    if (fresh()) return { eligible: [], picked: undefined }
    const eligible = chains().filter((chain) =>
      pillEligible(chain, {
        sessionBranch: meta.branch || undefined,
        sessionRepo: meta.repo || undefined,
        sessionHeadSha: meta.headSha || undefined,
        armed: ctx.stores.armed.value.entries,
      }),
    )
    const normal = pillPick(eligible, waitForAllStatusChecks())
    // Single-pin override: pull identity (or chain key) bypasses eligibility.
    // Expiry is disappearance: a pinned chain that's gone unpins on next rechain.
    const pinned = pinnedChain(chains(), ctx.stores.pinned.value)
    if (pinned) return { eligible, picked: { chain: pinned, reason: "pinned" as const, considered: eligible.length + 1 } }
    return { eligible, picked: normal }
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
  // The menu's merge-when-ready toggle binds to the first open PR across
  // eligible chains (pinned first when it has one open). Reactive.
  const menuLead = createMemo(() => {
    const pinned = pillState().picked?.reason === "pinned" ? pillState().picked!.chain : undefined
    const pinnedOpen = pinned?.prs.filter((pull) => pull.state === "open").map((pull) => ({ chain: pinned, pull }))[0]
    return pinnedOpen ?? pillState().eligible.flatMap((chain) => chain.prs.filter((pull) => pull.state === "open").map((pull) => ({ chain, pull })))[0]
  })

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

  /** Fires the merge RPC (head-SHA guarded; method and delete-branch from settings)
   * and toasts the outcome. No confirmation — callers own consent. Every outcome
   * lands in the activity ledger: merges, deletions, failures. */
  const fireMerge = async (
    pull: PullEntity,
    method: "merge" | "squash" | "rebase",
    via: "manual" | "when-ready",
  ): Promise<"merged" | "failed" | "head-changed" | "in-flight" | "already-handled"> => {
    const current = session()
    const client = ctx.client
    if (!current || !client) return "failed"
    const origin = { sessionID: current.id, directory: current.directory, repo: meta.repo }
    const deleteBranch = ctx.stores.settings.value.deleteBranch
    const result = await client
      .rpc(Muninn)
      .merge({
        directory: current.directory,
        number: pull.number,
        method,
        expectedHeadSha: pull.headSha,
      })
      .catch((error: unknown) => ({
        merged: false as const,
        message: error instanceof Error ? error.message : String(error),
        headChanged: false,
        inFlight: false,
        alreadyHandled: false,
      }))
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

  /** Merges a pull request now: confirms in the app's dialog (naming exactly what
   * happens), then fires the provider merge guarded by the PR's head SHA. */
  const mergePull = async (pull: PullEntity): Promise<void> => {
    const method = ctx.stores.settings.value.mergeMethod
    const deleteBranch = ctx.stores.settings.value.deleteBranch
    const fastForward = ctx.stores.settings.value.fastForwardBase
    const reviewNotice = pendingReviewNotice(pull)
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
    await fireMerge(pull, method, "manual")
    void refresh()
  }

  /** Arms or disarms merge-when-ready. Arming is local — Muninn watches the chain
   * and fires the merge itself when checks and reviews are green; the forge's own
   * auto-merge is never used. Arming confirms once; that consent carries. */
  const armPull = async (pull: PullEntity, enable: boolean): Promise<void> => {
    if (enable) {
      const method = ctx.stores.settings.value.mergeMethod
      const deleteBranch = ctx.stores.settings.value.deleteBranch
      const fastForward = ctx.stores.settings.value.fastForwardBase
      const reviewNotice = pendingReviewNotice(pull)
      const kind = await checkoutKind(session()?.directory ?? "")
      const sentences = [`Muninn watches "${pull.title}" and merges into ${pull.baseBranch} with ${method} once checks pass and merge requirements are satisfied.`]
      if (fastForward && (!deleteBranch || kind !== "canonical"))
        sentences.push(`It will also fast-forward the local ${pull.baseBranch} when safe.`)
      if (deleteBranch)
        sentences.push(kind === "canonical"
          ? `It will switch to ${pull.baseBranch}${fastForward ? ", fast-forward it when safe," : ""} and delete the local branch ${pull.headBranch} when possible.`
          : `It will delete the clean local tree and branch ${pull.headBranch} when possible.`)
      if (reviewNotice) sentences.push(`${reviewNotice[0]!.toUpperCase()}${reviewNotice.slice(1)} — arming proceeds without an approval.`)
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
      void refresh()
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
    void refresh()
  }

  /** Fires ready armed entries once per PR. A stale head stays armed but is
   * blocked until a successful refresh observes a different head SHA. */
  const driveArmedMerges = () => {
    for (const { pull, method } of armedTargets(ctx.stores.armed.value.entries, chains(), waitForAllStatusChecks())) {
      const key = mergeKey(pull.repo, pull.number)
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
        const outcome = await fireMerge(pull, method, "when-ready").catch((error: unknown) => {
          console.error("[muninn] merge-when-ready failed", error)
          return "failed" as const
        })
        if (outcome === "head-changed") rejectedHeadByPR.set(key, pull.headSha)
        if (outcome === "merged") {
          removeArm(attempt)
          rejectedHeadByPR.delete(key)
        }
        if (outcome === "failed") removeArm(attempt)
        if (outcome === "already-handled") removeArm(attempt)

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

        const refreshed = await refresh(pull)
        mergeInFlight.delete(key)
        if (!sessionAttemptCurrent(attemptSession, session())) return

        if (outcome === "head-changed") {
          const stillArmed = ctx.stores.armed.value.entries.some(
            (candidate) => mergeKey(candidate.repo, candidate.number) === key,
          )
          if (!stillArmed) rejectedHeadByPR.delete(key)
          const currentPull = refreshedPullByPR.get(key)
          const ready = armedTargets(ctx.stores.armed.value.entries, chains(), waitForAllStatusChecks()).some(
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

  // Diagnostics footer: the pill's full decision state, plus which builds are loaded.
  const debugLine = () => {
    const current = session()
    const gate = current?.id === meta.sessionID ? "✓" : "✗"
    const { eligible, picked } = pillState()
    // The capsule's exact pick, then the why: which rule won and out of how many
    // candidates, and how the chain chose its lead PR. Read from the same memo
    // the capsule uses — eligibility and pick are never recomputed per consumer.
    const lead = picked?.chain.prs.find((pull) => pull.state === "open" || pull.state === "draft") ??
      (picked?.reason === "merged" ? picked.chain.prs.find((pull) => pull.state === "merged") : undefined)
    const run = picked ? latestRun(picked.chain.runs) : undefined
    const pill = !picked
      ? eligible.length > 0
        ? "off: no eligible chains"
        : "off: nothing eligible"
      : lead
        ? `#${lead.number} ${lead.title.slice(0, 36)}${lead.state === "merged" ? " · merged" : ""}`
        : run
          ? `run #${run.id}`
          : "off"
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
    const error = meta.error ? ` · err ${meta.error.slice(0, 200)}` : ""
    const pullEvidence = pillPullDiagnostics(lead)
    return `mn gui ${__MN_BUILD__}${meta.debug ? ` · ${meta.debug}` : " · srv ?"} · gate ${gate} ${current?.id ?? "?"} · chains ${chains().length} · eligible ${eligible.length} · pill: ${pill} · ${pick}${pullEvidence ? ` · ${pullEvidence}` : ""} · refs ${refList.length} (user ${tiers.user} cmd ${tiers.command} prose ${tiers.prose} out ${tiers.output}) → hits ${hits}/${Object.keys(entities).length} ents${error}${meta.stats ? ` · ${meta.stats}` : ""}`
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

  ctx.add(ComposerPill, {
    id: "links",
    order: 10,
    show: (input) => {
      if (!input.session || input.session.id !== meta.sessionID) return undefined
      const { eligible: list, picked } = pillState()
      if (list.length === 0 || !picked) return undefined

      // PR chains are the primary work: the pill leads with the worst-toned PR
      // chain (failing/conflicted/review-blocked beats a calm newer one), else
      // the most recently updated; run-only chains are the last resort. The
      // pick comes from the shared memo — exactly what the footer reports.
      const worst = picked.chain
      const lead = worst.prs.find((pull) => pull.state === "open" || pull.state === "draft") ??
        (picked.reason === "merged" || picked.reason === "pinned" ? worst.prs.find((pull) => pull.state === "merged") ?? worst.prs[0] : undefined)
      const run = latestRun(worst.runs)
      if (!lead && !run) return undefined
      const chainStatus = chainTone(worst, waitForAllStatusChecks())
      const tone = pillStatusTone(lead?.state, chainStatus)

      // The icon shape encodes the provider merge state; pill tone still encodes
      // overall chain health. The label stays `#number title ⌄`. An armed lead PR
      // puts a ticking braille spinner in front: a merge is pending. A pinned
      // chain pins the label with a pushpin so the override is visible.
      const mergeStatus = lead?.state === "open" ? lead.mergeState : undefined
      const circle = pillStatusIcon(lead?.state, mergeStatus, tone, pillIcon(meta.provider))
      const pending = lead?.state === "open" ? isArmed(lead) : false
      const pinnedMark = picked.reason === "pinned" ? "📌 " : ""
      const short = (title: string): string => (title.length > 24 ? `${title.slice(0, 24)}…` : title)

      return {
        icon: circle,
        label: lead
          ? `${pinnedMark}${pending ? `${SPIN_FRAMES[spin()]} ` : ""}#${lead.number} ${short(lead.title)}${lead.state === "merged" ? ` · ${ctx.t("state.merged")}` : ""} ▾`
          : `${pinnedMark}run #${run!.id}${run!.status === "succeeded" ? "" : ` · ${ctx.t(`state.${run!.status}`)}`} ▾`,
        tone,
        title: lead
          ? `${picked.reason === "pinned" ? `${ctx.t("pill.pinned")} · ` : ""}#${lead.number} ${lead.title}${lead.state === "merged"
            ? ` · merged${lead.mergedAt === undefined ? "" : ` · ${new Date(lead.mergedAt).toLocaleString()}`}`
            : lead.state === "open"
              ? ` · merge ${mergeStatus ?? "unknown"}${lead.reviewState ? ` · reviews ${lead.reviewState}` : ""}`
              : ""}`
          : ctx.t("pill.title"),
      }
    },
    // The pill's dropdown: the full chain picture with the merge controls the
    // sidebar has, plus the merge-method/delete-branch choices. Reads the stores
    // itself, so it stays live while open. Run ids live only here (pill grammar).
    menu: (input) => {
      // The lead open PR across eligible chains: the footer's merge-when-ready
      // toggle binds to it. Reactive — the popover updates while it's open.
      return (
      <div class="mn-pop">
        <For each={pillState().eligible.slice(0, 3)}>
          {(chain) => (
            <div class="mn-pop-chain" data-tone={chainTone(chain, waitForAllStatusChecks())}>
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
                      {pull.state === "open" && pull.mergeState == null ? <UnknownGlyph /> : <MergeGlyph />}
                    </span>
                    <span class="mn-pop-id">#{pull.number}</span>
                    <span class="mn-pop-title">{pull.title}</span>
                    <MergeButton
                      chain={chain}
                      pull={pull}
                      isArmed={isArmed}
                      waitForAllStatusChecks={waitForAllStatusChecks}
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
          )}
        </For>
        <Show when={menuLead()}>
        <div class="mn-pop-foot">
          <div class="mn-pop-line">
            <Show when={menuLead()}>
              {(lead) => (
                <label
                  class="mn-pop-toggle"
                  title={
                    isArmed(lead().pull)
                      ? `Muninn is driving the merge (${lead().pull.autoMerge ? "also armed on the forge" : "armed locally"}); ${mergeReady(lead().chain, lead().pull, waitForAllStatusChecks()) ? "merging on the next check (within ~30s)" : `waiting: ${mergeWhy(lead().chain, lead().pull, waitForAllStatusChecks())}`} — click to cancel`
                      : mergeReady(lead().chain, lead().pull, waitForAllStatusChecks())
                        ? "green now — Muninn merges on its next check (within ~30s)"
                        : `Muninn merges once checks pass and merge requirements are satisfied — now blocked: ${mergeWhy(lead().chain, lead().pull, waitForAllStatusChecks())}`
                  }
                >
                  <input
                    type="checkbox"
                    checked={isArmed(lead().pull)}
                    onChange={(event) => void armPull(lead().pull, event.currentTarget.checked)}
                  />
                  merge when ready
                </label>
              )}
            </Show>
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
            waitForAllStatusChecks={waitForAllStatusChecks}
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
        {
          id: "wait-for-all-status-checks",
          title: ctx.t("settings.waitForAllStatusChecks"),
          description: ctx.t("settings.waitForAllStatusChecks.description"),
          keywords: "merge checks status ci ready",
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
  // Draft locally so mid-word keystrokes ("ope…") never normalize the stored
  // setting; persist only complete valid backend names. External changes
  // (another window) are adopted when the draft holds a valid value.
  const [providerDraft, setProviderDraft] = createSignal<string>(ctx.stores.settings.value.candidateProvider ?? "heuristic")
  createEffect(() => {
    const current = ctx.stores.settings.value.candidateProvider ?? "heuristic"
    if (isDecisionBackend(providerDraft()) && providerDraft() !== current) setProviderDraft(current)
  })
  // Model IDs are free text: commit trailing-edge debounced so typing never
  // wipes verdicts or re-arms the judge per keystroke. The timer is local to
  // this component and cleared on unmount.
  const [modelDraft, setModelDraft] = createSignal<string>(ctx.stores.settings.value.candidateModel ?? "")
  let modelCommit: ReturnType<typeof setTimeout> | undefined
  let committedModel = ctx.stores.settings.value.candidateModel ?? ""
  onCleanup(() => clearTimeout(modelCommit))
  createEffect(() => {
    // Tracks ONLY the store: keystrokes update the draft signal, which this
    // effect never reads, so typing can never retrigger it mid-word. Only a
    // genuine external write (another window) diverges from the last commit
    // and gets adopted.
    const current = ctx.stores.settings.value.candidateModel ?? ""
    if (current !== committedModel) {
      committedModel = current
      setModelDraft(current)
    }
  })

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
          id="candidate-provider"
          title={ctx.t("settings.candidateProvider")}
          description={ctx.t("settings.candidateProvider.description")}
        >
          <ui.TextInput
            value={providerDraft()}
            label={ctx.t("settings.candidateProvider")}
            onInput={(value) => {
              setProviderDraft(value)
              const v = value.trim().toLowerCase()
              if (isDecisionBackend(v)) ctx.stores.settings.update((draft) => { draft.candidateProvider = v })
            }}
          />
        </ui.SettingsRow>
        <ui.SettingsRow
          id="candidate-model"
          title={ctx.t("settings.candidateModel")}
          description={ctx.t("settings.candidateModel.description")}
        >
          <ui.TextInput
            value={modelDraft()}
            label={ctx.t("settings.candidateModel")}
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
.mn-kind[data-state="pr-merged"] { color: #8250df; }
.mn-kind[data-state="issue-closed"] { color: var(--v2-text-text-accent); }
.mn-chain[data-tone="warning"] .mn-kind[data-state="pr-merged"], .mn-pop-chain[data-tone="warning"] .mn-kind[data-state="pr-merged"] { color: var(--v2-state-fg-warning); }
.mn-chain[data-tone="danger"] .mn-kind[data-state="pr-merged"], .mn-pop-chain[data-tone="danger"] .mn-kind[data-state="pr-merged"] { color: var(--v2-state-fg-danger); }
.mn-kind[data-state="pr-closed"] { color: var(--v2-state-fg-danger); }
.mn-kind[data-state="pr-conflict"] { color: var(--v2-icon-icon-muted); }
.mn-id { font-family: var(--v2-font-family-code); font-size: 11.5px; font-weight: 600; flex: none; cursor: copy; }
.mn-id.copied { color: var(--v2-state-fg-success); }
.mn-chain[data-stale="true"] { opacity: .55; }
.mn-title { flex: 1; min-width: 0; font-size: 12px; color: var(--v2-text-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mn-pin {
  flex: none; display: none; align-items: center; justify-content: center;
  width: 22px; height: 22px; margin: -4px 0; border: 0; border-radius: 6px; padding: 0;
  background: transparent; color: var(--v2-text-text-faint); cursor: pointer;
}
/* No reserved slot: the pin takes no space until its row is hovered or
 * focused, shifting the row's tail left at that moment. A pinned chain keeps
 * its highlighted pin (and slot) always so the override stays discoverable. */
.mn-row:hover .mn-pin { display: inline-flex; }
.mn-pin:hover { background: var(--v2-overlay-simple-overlay-hover); color: var(--v2-text-text-base); }
.mn-pin:focus-visible { display: inline-flex; outline: 1px solid var(--v2-state-fg-warning, #9a6700); }
.mn-pin[data-pinned="true"] { display: inline-flex; color: var(--v2-text-text-accent, #0969da); }
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
.mn-audit {
  display: flex; align-items: center; gap: 8px; padding: 5px 12px 6px;
  border-top: 1px solid var(--v2-border-border-muted); margin-top: 3px;
  font-size: 10.5px; font-family: var(--v2-font-family-code);
  color: var(--v2-state-fg-success, #1a7f37);
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
.mn-copy-link { flex: none; border: 0; border-radius: 4px; padding: 2px 5px; background: transparent; color: var(--v2-text-text-muted); font: inherit; font-size: 10px; cursor: pointer; }
.mn-copy-link:hover { background: var(--v2-overlay-simple-overlay-hover); color: var(--v2-text-text-base); }
.mn-pop-id { font-family: var(--v2-font-family-code); font-size: 11px; color: var(--v2-text-text-muted); flex: none; }
.mn-pop-title { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--v2-text-text-base); }
.mn-pop-more { padding: 4px 8px; font-size: 11px; color: var(--v2-text-text-faint); cursor: pointer; border-radius: 7px; }
.mn-pop-more:hover { background: var(--v2-overlay-simple-overlay-hover); color: var(--v2-text-text-muted); }
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

/* Merge action: green when ready, amber while checks run, grey when blocked. */
.mn-merge {
  flex: none; font-size: 10.5px; font-weight: 600; line-height: 1;
  padding: 4px 9px; border-radius: 6px; cursor: pointer;
  color: var(--v2-state-fg-on-success, #fff);
  background: var(--v2-state-bg-success, #1a7f37); border: none;
}
.mn-merge:hover { filter: brightness(1.1); }
.mn-merge.pending {
  background: var(--v2-state-bg-warning, #9a6700);
  color: var(--v2-text-text-base, #161616);
}
.mn-merge.armed {
  background: none; color: var(--v2-state-fg-warning, #9a6700);
  box-shadow: inset 0 0 0 .5px var(--v2-state-border-warning, #9a6700);
  display: inline-flex; align-items: center; gap: 5px;
}
.mn-merge.armed:hover { background: var(--v2-overlay-simple-overlay-hover); filter: none; }
/* The pending-merge spinner rides inside the Armed button, tinted by it. */
.mn-merge.armed .mn-spin {
  width: 9px; height: 9px; border: 1px solid transparent;
  border-top-color: currentColor; border-left-color: currentColor;
  animation-duration: 1.1s;
}

/* Merge-status glyph: GitHub's circle-dot, colored by merge state. */
.mn-merge-state { color: var(--v2-icon-icon-muted); flex: none; display: inline-flex; }
.mn-merge-state[data-state="ready"] { color: var(--v2-state-fg-success, #1a7f37); }
.mn-merge-state[data-state="pending"] { color: var(--v2-state-fg-warning, #9a6700); }
.mn-merge-state[data-state="blocked"] { color: var(--v2-state-fg-danger, #cf222e); }
.mn-merge-state[data-state="unknown"] { color: var(--v2-icon-icon-muted); }
.mn-merge-state[data-state="conflict"] { color: var(--v2-icon-icon-muted); }
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
