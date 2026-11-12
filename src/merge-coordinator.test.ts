import { describe, expect, test } from "bun:test"
import { RESULT_TTL_MS, coordinateMerge } from "./merge-coordinator"

describe("coordinateMerge", () => {
  test("allows only one active merge for the same PR", async () => {
    let finish: ((result: { merged: true }) => void) | undefined
    let calls = 0
    const first = coordinateMerge("repo#1", "sha", () => {
      calls += 1
      return new Promise((resolve) => { finish = resolve })
    })
    const second = await coordinateMerge("repo#1", "sha", async () => {
      calls += 1
      return { merged: true }
    })
    finish?.({ merged: true })
    expect(await first).toEqual({ merged: true })
    expect(second).toEqual({ merged: false, inFlight: true })
    expect(calls).toBe(1)
  })

  test("deduplicates confirmed success without reporting a second success", async () => {
    expect(await coordinateMerge("repo#2", "sha", async () => ({ merged: true }))).toEqual({ merged: true })
    expect(await coordinateMerge("repo#2", "sha", async () => ({ merged: true }))).toEqual({
      merged: false,
      alreadyHandled: true,
    })
  })

  test("remembers a rejected head across windows but allows a new SHA", async () => {
    let attempts = 0
    const stale = async () => {
      attempts += 1
      return { merged: false as const, headChanged: true }
    }
    expect(await coordinateMerge("repo#3", "old", stale)).toEqual({ merged: false, headChanged: true })
    expect(await coordinateMerge("repo#3", "old", stale)).toEqual({
      merged: false,
      headChanged: true,
      message: "This head was already rejected as stale",
    })
    expect(await coordinateMerge("repo#3", "new", async () => ({ merged: true }))).toEqual({ merged: true })
    expect(attempts).toBe(1)
  })

  test("keeps an old rejected SHA blocked after a different head was attempted", async () => {
    let attempts = 0
    const stale = async () => {
      attempts += 1
      return { merged: false as const, headChanged: true }
    }
    await coordinateMerge("repo#5", "old", stale)
    await coordinateMerge("repo#5", "new", stale)
    expect(await coordinateMerge("repo#5", "old", stale)).toMatchObject({ merged: false, headChanged: true })
    expect(attempts).toBe(2)
  })

  test("releases the active claim after failures", async () => {
    expect(await coordinateMerge("repo#4", "sha", async () => { throw new Error("offline") }).catch(() => "threw"))
      .toBe("threw")
    expect(await coordinateMerge("repo#4", "sha", async () => ({ merged: true }))).toEqual({ merged: true })
  })

  test("lets an open-after-merged retry after the dedupe grace", async () => {
    const t0 = Date.now()
    let calls = 0
    const merge = async () => {
      calls += 1
      return { merged: true as const }
    }
    expect(await coordinateMerge("repo#6", "sha", merge, t0)).toEqual({ merged: true })
    expect(await coordinateMerge("repo#6", "sha", merge, t0 + RESULT_TTL_MS - 1)).toEqual({
      merged: false,
      alreadyHandled: true,
    })
    expect(await coordinateMerge("repo#6", "sha", merge, t0 + RESULT_TTL_MS + 1)).toEqual({ merged: true })
    expect(calls).toBe(2)
  })
})
