/**
 * The mark registry: provider glyphs and pill icons, keyed by provider id. The GUI
 * resolves provider from the entity's repo host — it never hardcodes one product.
 */

import type { JSX } from "solid-js"
import type { IconName } from "@opencode/plugin/gui"
import type { ProviderID } from "../model"
import { githubLexicon } from "../providers/github/lexicon"
import { GitHubMark } from "./icons"

const marks: Record<ProviderID, () => JSX.Element> = { github: GitHubMark }

const pillIcons: Record<ProviderID, IconName> = { github: "github" }

const lexicons = [githubLexicon]

export const providerByHost = (host: string | undefined | null): ProviderID | undefined =>
  host ? lexicons.find((lexicon) => lexicon.host === host)?.provider : undefined

/** The product glyph for a provider id, or for a repository host. */
export const Mark = (props: { provider?: ProviderID | null; host?: string | null }): JSX.Element => {
  const provider = props.provider ?? providerByHost(props.host)
  const component = (provider && marks[provider]) || GitHubMark
  return component()
}

/** The app icon name for pills, where the SDK wants an IconName string. */
export const pillIcon = (provider?: string | null): IconName =>
  provider && provider in pillIcons ? pillIcons[provider as ProviderID] : "globe"
