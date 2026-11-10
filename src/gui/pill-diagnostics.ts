import type { PullEntity } from "../model"

const shortSha = (sha: string | undefined): string => sha ? sha.slice(0, 7) : "missing"

/** Compact evidence for explaining the selected PR's pill state in the footer. */
export const pillPullDiagnostics = (pull: PullEntity | undefined): string | undefined => {
  if (!pull) return undefined
  const checks = pull.statusChecks
  const checkEvidence = checks
    ? `${checks.state}@${shortSha(checks.headSha)}`
    : "missing"
  return `pr#${pull.number} state=${pull.state} merge=${pull.mergeState ?? "unknown"} head=${shortSha(pull.headSha)} checks=${checkEvidence}`
}
