import { describe, expect, test } from "bun:test"
import { CUSTOM_PROVIDER, mergeProviderOptions, resolveCustomCommit } from "./provider-options"

const labels = (id: string) => (id === CUSTOM_PROVIDER ? "Custom…" : `label:${id}`)
const base = { catalogIds: ["opencode", "openrouter"], discoveredIds: ["acme"], fallback: "opencode", labels }

describe("mergeProviderOptions", () => {
  test("blank stored selects the fallback without custom input", () => {
    const merged = mergeProviderOptions({ ...base, stored: "" })
    expect(merged.selectValue).toBe("opencode")
    expect(merged.showCustomInput).toBe(false)
    expect(merged.options.map((o) => o.value)).toEqual(["opencode", "openrouter", "acme", CUSTOM_PROVIDER])
  })

  test("known stored IDs select directly", () => {
    expect(mergeProviderOptions({ ...base, stored: "acme" }).selectValue).toBe("acme")
    const merged = mergeProviderOptions({ ...base, stored: "openrouter" })
    expect(merged.selectValue).toBe("openrouter")
    expect(merged.showCustomInput).toBe(false)
  })

  test("unknown stored IDs are preserved via the custom entry, never coerced", () => {
    const merged = mergeProviderOptions({ ...base, stored: "my-gateway" })
    expect(merged.selectValue).toBe(CUSTOM_PROVIDER)
    expect(merged.showCustomInput).toBe(true)
    // The raw value is not rewritten into the options: it lives in the input.
    expect(merged.options.every((o) => o.value !== "my-gateway")).toBe(true)
  })

  test("custom entry carries a label", () => {
    const merged = mergeProviderOptions({ ...base, stored: "" })
    expect(merged.options.at(-1)).toEqual({ value: CUSTOM_PROVIDER, label: "Custom…" })
  })
})

describe("resolveCustomCommit", () => {
  const known = ["opencode", "openrouter", "acme"]

  test("blank clears the store and leaves custom mode", () => {
    expect(resolveCustomCommit("", known)).toEqual({ store: undefined, forced: false })
    expect(resolveCustomCommit("   ", known)).toEqual({ store: undefined, forced: false })
  })

  test("known IDs commit verbatim and leave custom mode", () => {
    expect(resolveCustomCommit("acme", known)).toEqual({ store: "acme", forced: false })
  })

  test("unknown IDs commit verbatim and stay in custom mode", () => {
    expect(resolveCustomCommit("my-gateway", known)).toEqual({ store: "my-gateway", forced: true })
  })
})
