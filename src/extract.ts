/**
 * Extracts source references from session text. Pure and dependency-free: it runs
 * inside the GUI bundle on every message change, so it must never touch Node or
 * network. Providers contribute URL and shorthand syntax through their lexicons;
 * kind words ("PR 4821", "issue 1043", "run 18402") and bare `#123` references are
 * forge-generic and resolve against the session's repository, which the caller
 * passes.
 */

import type { Ref, RepoRef } from "./model"
import type { Lexicon } from "./providers/lexicon"

/** Strip fenced code blocks and inline code spans: their `#123`s are prose, not references. */
const stripCode = (text: string): string =>
  text.replace(/```[\s\S]*?```/g, " ").replace(/~~~[\s\S]*?~~~/g, " ").replace(/`[^`\n]*`/g, " ")

const kindWordPattern = /\b(pull request|pr|issue|check run|run)\s+#?(\d+)\b/gi
const bareHashPattern = /(?<![/\w&])#(\d+)\b/g

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
    for (const match of source.matchAll(kindWordPattern)) {
      // An explicit URL or shorthand reference with the same number is authoritative:
      // `[PR #2494](configs/pull/2494)` must not also create a phantom for the
      // session's own repository.
      if (explicitNumbers.has(Number(match[2]))) continue
      add({
        kind: kindWordMap[match[1]!.toLowerCase() as keyof typeof kindWordMap],
        number: Number(match[2]),
        repo,
      })
    }
    for (const match of source.matchAll(bareHashPattern)) {
      if (explicitNumbers.has(Number(match[1]))) continue
      add({ number: Number(match[1]), repo })
    }
  }

  return [...found.values()]
}

/** Flattens a session's parts into the text Quartermaster should scan: text parts
 * and tool outputs (where gh/shell results — run links, PR urls — actually live). */
export const textToScan = (parts: readonly unknown[]): string =>
  parts
    .flatMap((part) => {
      if (!part || typeof part !== "object") return []
      const candidate = part as { type?: unknown; text?: unknown; state?: { output?: unknown } }
      if (candidate.type === "text" && typeof candidate.text === "string") return [candidate.text]
      if (candidate.type === "tool") {
        const output = candidate.state?.output
        if (typeof output === "string") return [output]
      }
      return []
    })
    .join("\n")
