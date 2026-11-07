/**
 * Reads a workspace's origin remote and parses it into repository coordinates.
 * Provider-agnostic: any https or scp-style git URL; the provider claims hosts.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

const exec = promisify(execFile)

export interface RemoteUrl {
  host: string
  owner: string
  repo: string
}

export const parseRemoteUrl = (url: string): RemoteUrl | undefined => {
  const https = url.match(/^https?:\/\/(?:www\.)?([^/]+)\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i)
  if (https) return { host: https[1]!.toLowerCase(), owner: https[2]!, repo: https[3]! }

  const ssh =
    url.match(/^[^@]+@([^:/]+):([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i) ??
    url.match(/^ssh:\/\/[^@]+@([^/]+)\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i)
  if (ssh) return { host: ssh[1]!.toLowerCase(), owner: ssh[2]!, repo: ssh[3]! }

  return undefined
}

/** Reads `origin` from the repository at `directory`. Undefined without a remote. */
export const readRemote = async (directory: string): Promise<RemoteUrl | undefined> => {
  try {
    const { stdout } = await exec("git", ["-C", directory, "remote", "get-url", "origin"], { timeout: 5_000 })
    return parseRemoteUrl(stdout.trim())
  } catch {
    return undefined
  }
}
