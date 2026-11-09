/**
 * Extracts source references from session text. Pure and dependency-free: it runs
 * inside the GUI bundle on every message change, so it must never touch Node or
 * network. Providers contribute URL and shorthand syntax through their lexicons;
 * kind words ("PR 4821", "issue 1043", "run 18402") and bare `#123` references are
 * forge-generic and resolve against the session's repository, which the caller
 * passes.
 */

import { refKey } from "./model"
import type { Ref, RepoRef } from "./model"
import type { Lexicon } from "./providers/lexicon"

/** Strip fenced code blocks and inline code spans: their `#123`s are prose, not references. */
const stripCode = (text: string): string =>
  text.replace(/```[\s\S]*?```/g, " ").replace(/~~~[\s\S]*?~~~/g, " ").replace(/`[^`\n]*`/g, " ")

// `[^\S\n]` — horizontal whitespace only: a kind word and its number must share a
// line, so line-numbered tool output ("…via-pr\n6: …") can't fabricate references.
const kindWordPattern = /\b(pull request|pr|issue|check run|run)[^\S\n]+#?(\d+)\b/gi
const bareHashPattern = /(?<![/\w&])#(\d+)\b/g
const ordinalHashPattern = /\b(?:feedback|finding|comment|step|item|option|point)[^\S\n]+(#\d+)\b/gi

const kindWordMap = {
  "pull request": "pr",
  pr: "pr",
  issue: "issue",
  "check run": "run",
  run: "run",
} as const

/** Where a reference's syntax came from — the evidence span a judge (or a
 * human reconstructing provenance) can cite. `kindword` outranks the explicit
 * syntaxes: a kind word singles a number out of its surroundings, even when a
 * URL or shorthand also carries it, and that is the deliberateness signal. */
export type Origin = "kindword" | "url" | "shorthand" | "bare"
const originRank: Record<Origin, number> = { kindword: 0, url: 1, shorthand: 2, bare: 3 }

/**
 * Pure syntax recognition: collects every reference from one block of session
 * text with its origin — no deliberateness policy lives here. `repo` is the
 * session's own repository: when absent, only self-contained references (URLs,
 * shorthand) are returned. Results are deduplicated; a kind learned from any
 * occurrence sticks; the strongest origin wins.
 */
export const scanDetailed = (text: string, repo?: RepoRef, lexicons: readonly Lexicon[] = []): (Ref & { origin: Origin })[] => {
  const source = stripCode(text)
  const found = new Map<string, Ref & { origin: Origin }>()
  /** Numbers seen in explicit references (URLs, shorthand) — they win over bare mentions. */
  const explicitNumbers = new Set<number>()

  const add = (ref: Ref & { origin: Origin }) => {
    const key = `${ref.repo ? `${ref.repo.host}/${ref.repo.owner}/${ref.repo.repo}` : "@"}#${ref.number}`
    const existing = found.get(key)
    // A kind learned from a URL or a kind word replaces an unknown kind; an
    // explicit repository wins over a session-repository reference only when it
    // differs; the strongest origin sticks.
    if (!existing) {
      found.set(key, ref)
      return
    }
    found.set(key, {
      number: ref.number,
      kind: existing.kind ?? ref.kind,
      repo: existing.repo ?? ref.repo,
      origin: originRank[ref.origin] < originRank[existing.origin] ? ref.origin : existing.origin,
    })
  }

  for (const lexicon of lexicons) {
    for (const pattern of lexicon.urls)
      for (const match of source.matchAll(pattern.re)) {
        const number = Number(match[pattern.numberGroup ?? 3])
        explicitNumbers.add(number)
        add({ kind: pattern.kind, number, repo: { host: lexicon.host, owner: match[1]!, repo: match[2]! }, origin: "url" })
      }
    if (lexicon.shorthand)
      for (const match of source.matchAll(lexicon.shorthand.re)) {
        explicitNumbers.add(Number(match[3]))
        add({ number: Number(match[3]), repo: { host: lexicon.host, owner: match[1]!, repo: match[2]! }, origin: "shorthand" })
      }
  }

  if (repo) {
    const ordinalHashPositions = new Set<number>()
    for (const match of source.matchAll(ordinalHashPattern)) {
      if (match.index !== undefined && match[1])
        ordinalHashPositions.add(match.index + match[0].length - match[1].length)
    }
    for (const match of source.matchAll(kindWordPattern)) {
      const number = Number(match[2])
      // A kind word singles its number out — even when an explicit URL already
      // carries it: then it only upgrades that ref's origin (no session-repo
      // phantom next to a ref that resolved to another repository).
      if (explicitNumbers.has(number)) {
        for (const [key, existing] of found) {
          if (existing.number === number && originRank.kindword < originRank[existing.origin])
            found.set(key, { ...existing, origin: "kindword" })
        }
        continue
      }
      add({
        kind: kindWordMap[match[1]!.toLowerCase() as keyof typeof kindWordMap],
        number,
        repo,
        origin: "kindword",
      })
    }
    for (const match of source.matchAll(bareHashPattern)) {
      if (explicitNumbers.has(Number(match[1])) || ordinalHashPositions.has(match.index!)) continue
      add({ number: Number(match[1]), repo, origin: "bare" })
    }
  }

  return [...found.values()]
}

/** `gh run list`-style enumerations dump dozens of run ids; a run only counts
 * when it is singled out. Many run refs at once means a listing — drop them,
 * unless the transcript singles one out with a kind word. One policy, applied
 * per block of text: `scan` keeps it for compat, `deliberateRefs` owns it. */
export const RUN_LISTING_LIMIT = 6

const listedRunKeys = (refs: readonly (Ref & { origin: Origin })[]): Set<string> => {
  const runRefs = refs.filter((ref) => ref.kind === "run")
  if (runRefs.length < RUN_LISTING_LIMIT) return new Set()
  return new Set(runRefs.filter((ref) => ref.origin !== "kindword").map((ref) => refKey(ref)))
}

/**
 * Compat wrapper: `scanDetailed` plus the run-listing suppression, the shape
 * and behavior callers have always gotten from `scan`. Deliberateness policy
 * lives in `deliberateRefs`; new callers should use `scanDetailed`.
 */
export const scan = (text: string, repo?: RepoRef, lexicons: readonly Lexicon[] = []): Ref[] => {
  const detailed = scanDetailed(text, repo, lexicons)
  const listed = listedRunKeys(detailed)
  return detailed.filter((ref) => !listed.has(refKey(ref))).map(({ origin: _origin, ...ref }) => ref)
}

/** Flattens a session's parts into the text Muninn should scan: text parts
 * and tool results (where gh/shell output — run links, PR urls, numbers — lives).
 * Tool outputs appear as `state.output` or `state.content[]` blocks depending on
 * the tool; the invoked command is scanned too. */
/** Flattens projected session messages (what the host's message.list returns) into
 * the text Muninn scans: user messages carry `text` directly; assistant
 * messages carry a `content[]` of text/reasoning items plus completed tool states
 * (where gh/shell output — run links, PR urls — actually lives). Structurally
 * typed so the core stays SDK-agnostic; the GUI call site is SDK-typed, so a
 * wrong field there still fails the build. */
export const messagesText = (messages: readonly unknown[]): string => {
  const out: string[] = []
  for (const message of messages) {
    if (!message || typeof message !== "object") continue
    const m = message as { type?: unknown; text?: unknown; content?: unknown }
    if (m.type === "user" && typeof m.text === "string") {
      out.push(m.text)
      continue
    }
    if (m.type !== "assistant" || !Array.isArray(m.content)) continue
    for (const part of m.content) {
      if (!part || typeof part !== "object") continue
      const p = part as { type?: unknown; text?: unknown; state?: unknown }
      if ((p.type === "text" || p.type === "reasoning") && typeof p.text === "string") {
        out.push(p.text)
        continue
      }
      if (p.type !== "tool") continue
      const state = p.state as { status?: unknown; input?: unknown; content?: unknown } | undefined
      if (!state || state.status !== "completed") continue
      if (state.input && typeof state.input === "object") {
        const command = (state.input as { command?: unknown }).command
        if (typeof command === "string") out.push(command)
      }
      if (Array.isArray(state.content))
        for (const block of state.content)
          if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
            const text = (block as { text?: unknown }).text
            if (typeof text === "string") out.push(text)
          }
    }
  }
  return out.join("\n")
}

/** The four provenance buckets Muninn scans, one per message-part kind. Tool
 * outputs stay grouped per tool call (array of arrays) so the listing rule can
 * judge each output on its own. */
export interface Buckets {
  user: string[]
  commands: string[]
  prose: string[]
  outputs: string[][]
}

export const messageBuckets = (messages: readonly unknown[]): Buckets => {
  const buckets: Buckets = { user: [], commands: [], prose: [], outputs: [] }
  for (const message of messages) {
    if (!message || typeof message !== "object") continue
    const m = message as { type?: unknown; text?: unknown; content?: unknown }
    if (m.type === "user" && typeof m.text === "string") {
      buckets.user.push(m.text)
      continue
    }
    if (m.type !== "assistant" || !Array.isArray(m.content)) continue
    for (const part of m.content) {
      if (!part || typeof part !== "object") continue
      const p = part as { type?: unknown; text?: unknown; state?: unknown }
      if ((p.type === "text" || p.type === "reasoning") && typeof p.text === "string") {
        buckets.prose.push(p.text)
        continue
      }
      if (p.type !== "tool") continue
      const state = p.state as { status?: unknown; input?: unknown; content?: unknown } | undefined
      if (!state || state.status !== "completed") continue
      if (state.input && typeof state.input === "object") {
        const command = (state.input as { command?: unknown }).command
        if (typeof command === "string") buckets.commands.push(command)
      }
      const output: string[] = []
      if (Array.isArray(state.content))
        for (const block of state.content)
          if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
            const text = (block as { text?: unknown }).text
            if (typeof text === "string") output.push(text)
          }
      if (output.length > 0) buckets.outputs.push(output)
    }
  }
  return buckets
}

/** How many refs of one kind a single tool output may name before it counts as
 * an enumeration (`gh pr list`, a search): enumerations are not candidates. */
export const LISTING_THRESHOLD = 3

export type Tier = "user" | "command" | "prose" | "output"
export type TieredRef = Ref & { tier: Tier }

/**
 * Refs worth chains — the one home of the deliberateness policy:
 * - every tier drops run listings (`RUN_LISTING_LIMIT`+ run refs in one block
 *   are an enumeration; a kind-worded run is singled out and survives);
 * - tool outputs additionally drop per-kind enumerations (`LISTING_THRESHOLD`+
 *   refs of one kind in one output block; one or two is a focused look: kept);
 * - everything the user typed, the agent committed to (tool commands) or told
 *   the user about (prose) is a candidate.
 * The same ref seen at several tiers keeps its highest (most deliberate) tier.
 */
export const deliberateRefs = (
  buckets: Buckets,
  repo: RepoRef | undefined,
  lexicons: readonly Lexicon[] = [],
): TieredRef[] => {
  const tierRank: Record<Tier, number> = { user: 0, command: 1, prose: 2, output: 3 }
  const byKey = new Map<string, TieredRef>()
  const put = (ref: Ref & { origin: Origin }, tier: Tier) => {
    const key = refKey(ref)
    const existing = byKey.get(key)
    if (!existing || tierRank[tier] < tierRank[existing.tier]) {
      // Rest-strip keeps each ref's own-key presence exactly (a merged bare ref
      // keeps its `kind` slot, undefined) — the shape callers have always gotten.
      const { origin: _origin, ...rest } = ref
      byKey.set(key, { ...rest, tier })
    }
  }
  const addBlock = (text: string, tier: Tier) => {
    const detailed = scanDetailed(text, repo, lexicons)
    const listed = listedRunKeys(detailed)
    for (const ref of detailed) if (!listed.has(refKey(ref))) put(ref, tier)
  }
  for (const text of buckets.user) addBlock(text, "user")
  for (const text of buckets.commands) addBlock(text, "command")
  for (const text of buckets.prose) addBlock(text, "prose")
  for (const output of buckets.outputs)
    for (const text of output) {
      const detailed = scanDetailed(text, repo, lexicons)
      const listed = listedRunKeys(detailed)
      const refs = detailed.filter((ref) => !listed.has(refKey(ref)))
      const perKind = new Map<string, number>()
      for (const ref of refs) {
        const group = ref.kind ?? "bare"
        perKind.set(group, (perKind.get(group) ?? 0) + 1)
      }
      for (const ref of refs) {
        const group = ref.kind ?? "bare"
        if ((perKind.get(group) ?? 0) < LISTING_THRESHOLD) put(ref, "output")
      }
    }
  return [...byKey.values()]
}

export const textToScan = (parts: readonly unknown[]): string =>
  parts
    .flatMap((part) => {
      if (!part || typeof part !== "object") return []
      const candidate = part as {
        type?: unknown
        text?: unknown
        state?: { output?: unknown; content?: unknown; input?: unknown }
      }
      if (candidate.type === "text" && typeof candidate.text === "string") return [candidate.text]
      if (candidate.type !== "tool") return []
      const out: string[] = []
      const state = candidate.state
      if (state && typeof state === "object") {
        if (typeof state.output === "string") out.push(state.output)
        if (Array.isArray(state.content))
          for (const block of state.content)
            if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string")
              out.push((block as { text: string }).text)
        if (state.input && typeof state.input === "object") {
          const command = (state.input as { command?: unknown }).command
          if (typeof command === "string") out.push(command)
        }
      }
      return out
    })
    .join("\n")
