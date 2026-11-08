/**
 * The mark registry: provider glyphs and pill icons, keyed by provider id. The GUI
 * resolves provider from an entity's stamped `provider` (with the repo host as
 * fallback) — it never hardcodes one product.
 */

import type { JSX } from "solid-js"
import type { IconName } from "@opencode/plugin/gui"
import { githubLexicon } from "../providers/github/lexicon"
import { GitHubMark } from "./icons"

/** Providers ForgeScout knows marks and icons for. Registry-validated on lookup. */
type KnownProvider = "github"

const marks: Record<KnownProvider, () => JSX.Element> = { github: GitHubMark }

const pillIcons: Record<KnownProvider, IconName> = { github: "github" }

const lexicons = [githubLexicon]

export const providerByHost = (host: string | undefined | null): KnownProvider | undefined =>
  host ? (lexicons.find((lexicon) => lexicon.host === host)?.provider as KnownProvider | undefined) : undefined

/** The product glyph for a provider id, or for a repository host. */
export const Mark = (props: { provider?: string | null; host?: string | null }): JSX.Element => {
  const provider = props.provider ?? providerByHost(props.host)
  const component = provider && provider in marks ? marks[provider as KnownProvider] : GitHubMark
  return component()
}

/** The app icon name for pills, where the SDK wants an IconName string. */
export const pillIcon = (provider?: string | null): IconName =>
  provider && provider in pillIcons ? pillIcons[provider as KnownProvider] : "globe"
