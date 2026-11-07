/**
 * GitHub's lexicon: which URLs and shorthand resolve to references. Pure — the GUI
 * bundles this; the network side of the provider lives in `../github`.
 */

import type { Lexicon } from "../lexicon"

const OWNER = String.raw`[\w.-]+`
const REPO = String.raw`[\w.-]+`

export const githubLexicon: Lexicon = {
  provider: "github",
  host: "github.com",
  urls: [
    {
      kind: "issue",
      re: new RegExp(String.raw`https://(?:www\.)?github\.com/(${OWNER})/(${REPO})/issues/(\d+)(?![/\w.-])`, "gi"),
    },
    {
      kind: "pr",
      re: new RegExp(String.raw`https://(?:www\.)?github\.com/(${OWNER})/(${REPO})/pull/(\d+)(?![/\w.-])`, "gi"),
    },
    {
      kind: "run",
      re: new RegExp(String.raw`https://(?:www\.)?github\.com/(${OWNER})/(${REPO})/actions/runs/(\d+)(?![/\w.-])`, "gi"),
    },
  ],
  shorthand: { re: new RegExp(String.raw`(?<![\w@/])(${OWNER})/(${REPO})#(\d+)\b`, "g") },
}
