import { ref, watch, type Ref } from "vue"

export type SingleItemId = string | undefined

export interface UseSingleSelectorOptions {
  value: Ref<SingleItemId>
}

export interface UseSingleSelectorReturn {
  value: Ref<SingleItemId>
}

/**
 * Single-select dialog state: mirrors an external `value` prop into a local ref
 * so the parent owns the source of truth while the dialog owns the in-flight
 * choice until the user confirms.
 */
export function useSingleSelectorDialogState(
  options: UseSingleSelectorOptions
): UseSingleSelectorReturn {
  const value = ref<SingleItemId>(options.value.value)

  watch(options.value, (next) => {
    value.value = next
  })

  return { value }
}
