/**
 * Creation evidence for flows that never check out the PR branch.
 *
 * A detached-HEAD session can run `gh pr create --head <branch>` and get a PR
 * URL back without ever matching the pill's live branch/SHA ownership. The
 * create command's own output URL is creation evidence — not a mention — so the
 * session's PR pills even though the checkout never moves.
 *
 * Generic over providers: each lexicon declares its own `creationCommand`, and
 * this scans only with the matching lexicon(s). Pure and GUI-safe: no Node, no
 * network. Conservative by construction: anything but exactly one bare URL
 * never seeds, so failures, compounds, and listings can't recruit unrelated
 * work. Attribution is shape-based (command anchor + single-URL output), never
 * prose-based, so no natural-language sniffing is involved.
 */

import { scanDetailed, splitTokens, splitTopLevel, stripQuoted, unquoteToken } from "../extract"
import type { Buckets } from "../extract"
import type { PullEntity, Ref, RepoRef } from "../model"
import { entityKey, repoKey } from "../model"
import type { Lexicon } from "../providers/lexicon"

/** Modes that never create, even though they match the create prefix. Flags are
 * CLI identifiers, not localized prose. */
const NON_CREATION_FLAGS = /(?:\s|^)(?:--help|-h|--dry-run)\b/

/**
 * Unquoted shell composition this extractor refuses to attribute: `;` chaining,
 * pipes (`|`), background/conjunction (`&`), and command-separating newlines.
 * Quoting is honored, so real multi-line `--body "..."` text (newlines,
 * backticks, prose) still seeds — only separators outside quotes reject.
 * Unsupported shapes safely produce no evidence instead of misattributing a
 * later URL (e.g. `create ... >/dev/null` newline `view …` whose only output
 * is another PR's plain URL).
 */
const hasUnquotedSeparator = (command: string): boolean => {
  let inSingle = false
  let inDouble = false
  let escaped = false
  for (const char of command) {
    if (inSingle) {
      if (char === "'") inSingle = false
      continue
    }
    if (inDouble) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === "\\") {
        escaped = true
        continue
      }
      if (char === '"') inDouble = false
      continue
    }
    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (char === "'") {
      inSingle = true
      continue
    }
    if (char === '"') {
      inDouble = true
      continue
    }
    if (char === ";" || char === "|" || char === "&" || char === "\n") return true
  }
  return false
}

const PLAIN_URL_ONLY = /^https?:\/\/\S+\s*$/

export const prCreateRefs = (
  buckets: Buckets,
  lexicons: readonly Lexicon[] = [],
): Ref[] => {
  const out: Ref[] = []
  const seen = new Set<string>()
  for (const output of buckets.outputs) {
    if (!output.command) continue
    // Non-creation modes and ambiguous unquoted compound invocations never
    // seed. Quoted `--body "..."` text (newlines, `;`, backticks) still seeds;
    // anything genuinely ambiguous produces no evidence, and branch/SHA
    // ownership still pills those.
    if (NON_CREATION_FLAGS.test(output.command)) continue
    if (hasUnquotedSeparator(output.command)) continue
    const matching = lexicons.filter((lexicon) => lexicon.creationCommand?.test(output.command!))
    if (matching.length === 0) continue
    // Successful creates print exactly one bare URL. JSON (`{"url": …}`),
    // help text plus a URL, failure prose, or multi-line output never seed —
    // the shape gate subsumes prose sniffing (and never false-negatives on
    // owner/repo names containing words like "error").
    const nonEmpty = output.texts.map((text) => text.trim()).filter((text) => text.length > 0)
    if (nonEmpty.length !== 1 || !PLAIN_URL_ONLY.test(nonEmpty[0]!)) continue
    const found = new Map<string, Ref>()
    for (const lexicon of matching)
      for (const text of output.texts)
        // Self-contained references only (URLs, shorthand): the create output's
        // PR URL carries kind+repo. Passing no session repo avoids recruiting
        // bare `#123` counters from the same output as creation evidence.
        for (const ref of scanDetailed(text, undefined, [lexicon])) {
          if (ref.kind !== "pr" || !ref.repo) continue
          const key = `${ref.repo.host}/${ref.repo.owner}/${ref.repo.repo}#pr${ref.number}`
          if (!found.has(key)) {
            const { origin: _origin, ...rest } = ref
            void _origin
            found.set(key, rest)
          }
        }
    // A successful create names exactly one PR in that bare URL. Anything else
    // (zero refs, several) never seeds.
    if (found.size !== 1) continue
    for (const [key, ref] of found) {
      if (seen.has(key)) continue
      seen.add(key)
      out.push(ref)
    }
  }
  return out
}

/**
 * Branch-linked creation evidence for the canonical `push && create` compound.
 *
 * The simple path above requires a lone `gh pr create` invocation with a lone
 * bare-URL output. Real sessions chain (`git push -u origin B 2>&1 | tail -4
 * && gh pr create --base main --head B ... | tail -3`), which that path
 * rejects three times over (off-anchor command, `|`/`&&` separators, push
 * noise beside the URL). This separate compound path attributes those — but
 * only within a bounded shape, and only after hydration confirms the PR's
 * head branch equals the `--head` value (see `validateCreateLinks`):
 *
 * - exactly one `pr create` invocation outside quotes;
 * - an optional approved prefix of `git push` / `cd` segments;
 * - an optional trailing `| tail` output filter;
 * - no other segments (a later `gh pr view EXISTING` that could supply another
 *   URL rejects, even when EXISTING shares the branch);
 * - no `--help`/`-h`/`--dry-run`, no unquoted command substitution;
 * - exactly one distinct PR URL across all output texts (push noise in *other*
 *   texts is tolerated; noise in the *same* text as the URL rejects).
 */

export interface CreateBranchLink {
  repo: RepoRef
  number: number
  headBranch: string
}

/** Quote-aware `--head` value (`--head B` / `--head=B`, quotes honored). */
const readHeadBranch = (segment: string): string | undefined => {
  const words = splitTokens(segment)
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    if (word === "--head" && i + 1 < words.length) {
      const value = words[i + 1]!
      if (value.startsWith("-")) return undefined
      return unquoteToken(value)
    }
    if (word.startsWith("--head=")) {
      const value = word.slice("--head=".length)
      if (value.length === 0 || value.startsWith("-")) return undefined
      return unquoteToken(value)
    }
  }
  return undefined
}

/** Tail-only pipe filters (`| tail`, `| tail -3`): bounded, no operands at all —
 * validated on preserved tokens so quoted file operands (`| tail "/tmp/x"`)
 * reject instead of vanishing under quote-stripping. */
const isTailPipe = (pipePartText: string): boolean => {
  const tokens = splitTokens(pipePartText)
  return (
    (tokens.length === 1 && tokens[0] === "tail") ||
    (tokens.length === 2 && tokens[0] === "tail" && /^-\d+$/.test(tokens[1]!))
  )
}

/**
 * Approved push prefixes: a `git push …` first stage whose extra `|` stages
 * are all tail filters. The single-URL output rule still guards attribution,
 * so a noisy push printing a second bare PR URL rejects the whole call.
 */
const isPushGroup = (pipeParts: string[]): boolean => {
  if (pipeParts.length === 0) return false
  if (!/^\s*git\s+push\b/.test(stripQuoted(pipeParts[0]!))) return false
  return pipeParts.slice(1).every((part) => isTailPipe(part))
}

/** Plain `cd …` stages (no pipes): only meaningful beside a push prefix. */
const isCdGroup = (pipeParts: string[]): boolean =>
  pipeParts.length === 1 && /^\s*cd\b/.test(stripQuoted(pipeParts[0]!))

/** Unquoted `&` outside `2>&1`-style redirections backgrounds or chains — never compound-safe. */
const hasBareAmpersand = (command: string): boolean => {
  for (const { text } of splitTopLevel(command)) {
    const stripped = stripQuoted(text).replace(/2?>&\d*/g, " ")
    if (stripped.includes("&")) return true
  }
  return false
}

export const prCreateBranchLinks = (
  buckets: Buckets,
  lexicons: readonly Lexicon[] = [],
): CreateBranchLink[] => {
  const out: CreateBranchLink[] = []
  const seen = new Set<string>()
  for (const output of buckets.outputs) {
    if (!output.command) continue
    if (NON_CREATION_FLAGS.test(output.command)) continue
    // Unquoted command substitution can smuggle another URL-producing
    // command into the line; quoted bodies stay legal.
    if (/`|\$\(/.test(stripQuoted(output.command))) continue
    if (hasBareAmpersand(output.command)) continue
    // Operators are structural here (unlike mention scanning): `;`, newlines
    // and `||` end the bounded shape outright. `&&` separates approved
    // stages; `|` stays inside a stage for tail-filter validation below.
    const clauses = splitTopLevel(output.command)
    if (clauses.some((clause) => clause.sep === ";" || clause.sep === "\n" || clause.sep === "||")) continue
    const groups: string[][] = []
    {
      let pipe: string[] = []
      for (const clause of clauses) {
        pipe.push(clause.text)
        if (clause.sep === "&&" || clause.sep === null) {
          groups.push(pipe)
          pipe = []
        }
      }
    }
    const createMatches = (firstPart: string): boolean =>
      lexicons.some((lexicon) => lexicon.creationCommand?.test(stripQuoted(firstPart)) === true)
    const createIdx = groups.findIndex((group) => createMatches(group[0] ?? ""))
    if (createIdx === -1) continue
    if (groups.findIndex((group, i) => i !== createIdx && createMatches(group[0] ?? "")) !== -1) continue
    // The create stage is last: a later `&& tail …` or `&& gh pr view …`
    // could supply another URL, so anything after rejects — even a
    // same-branch view (branch validation must never see a foreign URL).
    if (createIdx !== groups.length - 1) continue
    const createParts = groups[createIdx]!
    if (!createParts.slice(1).every((part) => isTailPipe(part))) continue
    const before = groups.slice(0, createIdx)
    const prefixOk =
      before.length === 0 ||
      (before.some(isPushGroup) &&
        before.every((group) => isPushGroup(group) || isCdGroup(group)))
    if (!prefixOk) continue
    const headBranch = readHeadBranch(createParts[0]!)
    if (!headBranch) continue
    // Exactly one distinct PR URL across every text: push noise in other
    // texts is tolerated, but noise sharing the URL's own text rejects, as do
    // "already exists" prose and JSON shapes (never standalone bare URLs).
    // Self-contained references only (no session repo): the URL carries kind
    // and repo, so bare `#123` counters can't recruit.
    const urls = new Map<string, CreateBranchLink>()
    for (const text of output.texts) {
      const trimmed = text.trim()
      if (trimmed.length === 0 || !PLAIN_URL_ONLY.test(trimmed)) continue
      for (const ref of scanDetailed(text, undefined, lexicons)) {
        if (ref.kind !== "pr" || !ref.repo) continue
        const key = `${ref.repo.host}/${ref.repo.owner}/${ref.repo.repo}#pr${ref.number}`
        if (!urls.has(key)) urls.set(key, { repo: ref.repo, number: ref.number, headBranch })
      }
    }
    // One PR, one branch link. Zero (no URL, JSON, prose) or several (listing
    // or a later view's URL smuggled past the shape gate) never seeds.
    if (urls.size !== 1) continue
    for (const [key, link] of urls) {
      if (seen.has(key)) continue
      seen.add(key)
      out.push(link)
    }
  }
  return out
}

/**
 * Gate branch links against hydrated PRs: a link seeds only when the same
 * repo+number hydrated whose head branch equals the `--head` value. Closed
 * work drops out like every other owned-memory path; merged work still seeds
 * (terminal dots, same as the created/mention paths).
 */
export const validateCreateLinks = (
  links: readonly CreateBranchLink[],
  pulls: readonly PullEntity[],
): string[] => {
  const keys: string[] = []
  for (const link of links) {
    const pull = pulls.find(
      (candidate) =>
        candidate.number === link.number &&
        repoKey(candidate.repo) === repoKey(link.repo) &&
        candidate.headBranch === link.headBranch,
    )
    if (!pull || pull.state === "closed") continue
    const key = entityKey(pull)
    if (!keys.includes(key)) keys.push(key)
  }
  return keys
}
