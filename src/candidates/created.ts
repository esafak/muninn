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
 * network. Conservative by construction: a failure ("already exists", error
 * prose) never seeds, and an output naming anything but exactly one PR never
 * seeds, so compound commands and listings can't recruit unrelated work.
 */

import { scanDetailed } from "../extract"
import type { Buckets } from "../extract"
import type { Ref } from "../model"
import type { Lexicon } from "../providers/lexicon"

/** Failure prose that must never count as creation, even when it names a URL. */
const FAILURE_MARKERS =
  /already exists|already open|failed|error|aborted|not created|could not|no pull request/i

/** Modes that never create, even though they match the create prefix. */
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
    if (output.texts.some((text) => FAILURE_MARKERS.test(text))) continue
    // Successful creates print exactly one bare URL. JSON (`{"url": …}`),
    // help text plus a URL, or multi-line prose never seed.
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
