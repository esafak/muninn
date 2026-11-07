/**
 * A provider's scanning lexicon: the pure, GUI-safe contribution to session
 * scanning. URL shapes and shorthand syntax belong to the provider; kind words
 * ("PR", "issue", "run") and bare `#123` references are forge-generic and stay in
 * the scanner core. No network, no Node — this is bundled into windows.
 */

import type { Kind, ProviderID } from "../model"

export interface UrlPattern {
  kind: Kind
  /** Global regex capturing (owner, repo, number). */
  re: RegExp
}

export interface Lexicon {
  provider: ProviderID
  /** The URL host this provider owns, e.g. "github.com". */
  host: string
  urls: readonly UrlPattern[]
  /** Supports `owner/repo#123` shorthand; the regex captures (owner, repo, number). */
  shorthand?: { re: RegExp }
}
