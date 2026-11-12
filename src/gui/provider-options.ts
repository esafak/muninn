/**
 * Pure provider-picker policy for the decision-model settings row. GUI-safe.
 * Choices merge the provider-layer catalog with live discovery (connected
 * providers serving decision models); unknown stored IDs are preserved via
 * a custom entry instead of being silently coerced.
 */

export const CUSTOM_PROVIDER = "__custom"

export interface ProviderPickerOption {
  readonly value: string
  readonly label: string
}

export interface ProviderPickerState {
  readonly options: readonly ProviderPickerOption[]
  /** Value for the Select: a known ID, the fallback, or CUSTOM_PROVIDER. */
  readonly selectValue: string
  /** Whether the custom-ID TextInput is shown. */
  readonly showCustomInput: boolean
}

export const mergeProviderOptions = (args: {
  readonly catalogIds: readonly string[]
  readonly discoveredIds: readonly string[]
  readonly stored: string
  readonly fallback: string
  readonly labels: (id: string) => string
}): ProviderPickerState => {
  const stored = args.stored.trim()
  const ids = [...new Set([...args.catalogIds, ...args.discoveredIds])]
  const options: ProviderPickerOption[] = [
    ...ids.map((id) => ({ value: id, label: args.labels(id) })),
    { value: CUSTOM_PROVIDER, label: args.labels(CUSTOM_PROVIDER) },
  ]
  const known = ids.includes(stored)
  return {
    options,
    selectValue: !stored ? args.fallback : known ? stored : CUSTOM_PROVIDER,
    showCustomInput: stored !== "" && !known,
  }
}

/** Applies a custom-ID commit: blank clears, known IDs leave custom mode,
 * unknown IDs stay in custom mode. Pure so the debounce race (pending commit
 * vs newer selection/write) is testable. */
export const resolveCustomCommit = (
  raw: string,
  knownIds: readonly string[],
): { store: string | undefined; forced: boolean } => {
  const v = raw.trim()
  if (!v) return { store: undefined, forced: false }
  return knownIds.includes(v) ? { store: v, forced: false } : { store: v, forced: true }
}
