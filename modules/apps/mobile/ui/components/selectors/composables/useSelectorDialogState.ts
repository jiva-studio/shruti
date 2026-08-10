import { ref, watch, type Ref } from "vue"

export type SingleItemId = string | undefined

export interface UseSingleSelectorOptions {
  value: Ref<SingleItemId>
  /** Whether the dialog is on screen. */
  open?: Ref<boolean>
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

  // Re-sync to the source of truth whenever the dialog (re)opens, so a pick the
  // parent did not accept — an abandoned edit, or a UI-language switch whose
  // chunk failed to load — doesn't persist as a phantom checkmark. Mirrors
  // MultiListItemSelectorDialog, which has always done this.
  if (options.open) {
    watch(options.open, (isOpen) => {
      if (isOpen) value.value = options.value.value
    })
  }

  return { value }
}
