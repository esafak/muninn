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

/**
 * Collects references from one block of session text. `repo` is the session's own
 * repository: when absent, only self-contained references (URLs, shorthand) are
 * returned. Results are deduplicated; a kind learned from any occurrence sticks.
 */
export const scan = (text: string, repo?: RepoRef, lexicons: readonly Lexicon[] = []): Ref[] => {
  const source = stripCode(text)
  const found = new Map<string, Ref>()
  /** Numbers seen in explicit references (URLs, shorthand) — they win over bare mentions. */
  const explicitNumbers = new Set<number>()
  /** Numbers written with a kind word ("run 906") — explicit intent, survives listing runs. */
  const kindWordNumbers = new Set<number>()

  const add = (ref: Ref) => {
    const key = `${ref.repo ? `${ref.repo.host}/${ref.repo.owner}/${ref.repo.repo}` : "@"}#${ref.number}`
    const existing = found.get(key)
    // A kind learned from a URL or a kind word replaces an unknown kind; an explicit
    // repository wins over a session-repository reference only when it differs.
    if (!existing) {
      found.set(key, ref)
      return
    }
    found.set(key, {
      number: ref.number,
      kind: existing.kind ?? ref.kind,
      repo: existing.repo ?? ref.repo,
    })
  }

  for (const lexicon of lexicons) {
    for (const pattern of lexicon.urls)
      for (const match of source.matchAll(pattern.re)) {
        const number = Number(match[pattern.numberGroup ?? 3])
        explicitNumbers.add(number)
        add({ kind: pattern.kind, number, repo: { host: lexicon.host, owner: match[1]!, repo: match[2]! } })
      }
    if (lexicon.shorthand)
      for (const match of source.matchAll(lexicon.shorthand.re)) {
        explicitNumbers.add(Number(match[3]))
        add({ number: Number(match[3]), repo: { host: lexicon.host, owner: match[1]!, repo: match[2]! } })
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
      // Intent is recorded even when an explicit URL also has the number: a
      // listing that names "run 906" keeps run 906 alive.
      kindWordNumbers.add(number)
      if (explicitNumbers.has(number)) continue
      add({
        kind: kindWordMap[match[1]!.toLowerCase() as keyof typeof kindWordMap],
        number,
        repo,
      })
    }
    for (const match of source.matchAll(bareHashPattern)) {
      if (explicitNumbers.has(Number(match[1])) || ordinalHashPositions.has(match.index!)) continue
      add({ number: Number(match[1]), repo })
    }
  }

  // `gh run list`-style enumerations dump dozens of run ids; a run only counts when
  // it is singled out. Many URL runs at once means a listing — drop them, unless
  // the transcript singles one out with a kind word.
  const result = [...found.values()]
  const urlRuns = result.filter((ref) => ref.kind === "run")
  if (urlRuns.length >= 6) return result.filter((ref) => ref.kind !== "run" || kindWordNumbers.has(ref.number))
  return result
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
 * Refs worth chains: everything the user typed, the agent committed to (tool
 * commands) or told the user about (prose) — plus tool outputs, except listings.
 * One output naming `LISTING_THRESHOLD`+ refs of a kind is an enumeration: that
 * kind drops from that output. One or two is a focused look: kept. The same ref
 * seen at several tiers keeps its highest (most deliberate) tier.
 */
export const deliberateRefs = (
  buckets: Buckets,
  repo: RepoRef | undefined,
  lexicons: readonly Lexicon[] = [],
): TieredRef[] => {
  const tierRank: Record<Tier, number> = { user: 0, command: 1, prose: 2, output: 3 }
  const byKey = new Map<string, TieredRef>()
  const put = (ref: Ref, tier: Tier) => {
    const key = refKey(ref)
    const existing = byKey.get(key)
    if (!existing || tierRank[tier] < tierRank[existing.tier]) byKey.set(key, { ...ref, tier })
  }
  for (const text of buckets.user) for (const ref of scan(text, repo, lexicons)) put(ref, "user")
  for (const text of buckets.commands) for (const ref of scan(text, repo, lexicons)) put(ref, "command")
  for (const text of buckets.prose) for (const ref of scan(text, repo, lexicons)) put(ref, "prose")
  for (const output of buckets.outputs)
    for (const text of output) {
      const refs = scan(text, repo, lexicons)
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
