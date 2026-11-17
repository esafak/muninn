/**
 * A provider's scanning lexicon: the pure, GUI-safe contribution to session
 * scanning. URL shapes and shorthand syntax belong to the provider; kind words
 * ("PR", "issue", "run") and bare `#123` references are forge-generic and stay in
 * the scanner core. No network, no Node — this is bundled into windows.
 */

import type { Kind, ProviderID } from "../model"

export interface UrlPattern {
  kind: Kind
  /** Global regex capturing (owner, repo, number) — `numberGroup` overrides the number index. */
  re: RegExp
  /** Capture index of the reference number; defaults to 3. */
  numberGroup?: number
}

/**
 * An executable CLI addressing pattern: matches one quote-aware command
 * segment that names a single entity (e.g. `gh pr view 2781`). The engine
 * splits command text on unquoted `&&`/`||`/`;`/`|`/newlines, strips quoted
 * spans, and tests each segment. On a match it takes the first bare number
 * as the reference and honors `--repo`/`-R` for repository attribution.
 * Must stay non-global (`.test()` is stateful on `/g` regexes).
 */
export interface CliAddress {
  kind: Kind
  /** Tests a quote-stripped command segment; must be anchored (`^`). */
  invocation: RegExp
}

export interface Lexicon {
  provider: ProviderID
  /** The URL host this provider owns, e.g. "github.com". */
  host: string
  urls: readonly UrlPattern[]
  /** Supports `owner/repo#123` shorthand; the regex captures (owner, repo, number). */
  shorthand?: { re: RegExp }
  /**
   * Matches a successful creation command's invocation (anchored at the start,
   * so `view …; pr create` and `echo pr create` never count). The GUI uses this
   * to treat the command's output URL as creation evidence instead of a mention.
   * Must stay non-global: it is consumed with `.test()`, which is stateful on
   * `/g` regexes (`lastIndex` advances and matching turns intermittent).
   */
  creationCommand?: RegExp
  /**
   * Executable CLI addressing patterns (e.g. `gh pr view 2781`). Pure data;
   * the engine in `extract.ts` owns segmentation, quote-stripping, number and
   * `--repo` handling. Keep provider-local per the architecture rules.
   */
  commands?: readonly CliAddress[]
}
