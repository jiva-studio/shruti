import { computed, ref, watch, type ComputedRef, type Ref } from "vue"
import { containsCaseInsensitive } from "../utils.js"

export type ItemId = string
export interface Item {
  id: ItemId
  title: string
}

export interface UseMultiSelectorOptions {
  items: Ref<readonly Item[]>
  selected: Ref<readonly ItemId[] | undefined>
}

export interface UseMultiSelectorReturn {
  searchQuery: Ref<string>
  selectedItemIds: Ref<ItemId[]>
  filteredItems: ComputedRef<Item[]>
  toggle: (id: ItemId, value: boolean) => void
}

/**
 * Multi-select dialog state. Mirrors an external `selected` prop into a
 * local ref so the dialog can mutate freely without leaking changes
 * upstream until the user confirms. Exposes a search-driven
 * `filteredItems` that always keeps already-selected entries visible
 * even when the query would hide them.
 */
export function useMultiSelectorDialogState(
  options: UseMultiSelectorOptions
): UseMultiSelectorReturn {
  const searchQuery = ref<string>("")
  const selectedItemIds = ref<ItemId[]>([...(options.selected.value ?? [])])

  watch(options.selected, (next) => {
    selectedItemIds.value = [...(next ?? [])]
  })

  const filteredItems = computed<Item[]>(() =>
    options.items.value.filter(
      (item) =>
        containsCaseInsensitive(item.title, searchQuery.value) ||
        selectedItemIds.value.includes(item.id)
    )
  )

  function toggle(id: ItemId, value: boolean): void {
    if (value) {
      if (!selectedItemIds.value.includes(id)) selectedItemIds.value.push(id)
    } else {
      selectedItemIds.value = selectedItemIds.value.filter((other) => other !== id)
    }
  }

  return { searchQuery, selectedItemIds, filteredItems, toggle }
}

export type SingleItemId = string | undefined

export interface UseSingleSelectorOptions {
  value: Ref<SingleItemId>
}

export interface UseSingleSelectorReturn {
  value: Ref<SingleItemId>
}

/**
 * Single-select dialog state. Same prop-mirroring contract as
 * `useMultiSelectorDialogState`: the parent owns the source of truth, the
 * dialog owns the in-flight choice.
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
