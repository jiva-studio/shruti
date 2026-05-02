import { computed, type ComputedRef, type Ref } from "vue"

export interface ActiveFirstChip {
  /** Stable key used for sort tie-breaking by `title.localeCompare`. */
  title: string
}

export interface UseActiveFirstOrderOptions<T extends ActiveFirstChip> {
  chips: Ref<readonly T[]> | ComputedRef<readonly T[]>
  /** Returns true when the chip currently carries a value. */
  isActive: (chip: T) => boolean
}

/**
 * Reorders a chip list so chips with an active value bubble to the front.
 * Chips with the same active state fall back to alphabetical (`localeCompare`)
 * order on `title`. Returns a fresh array each time so consumers can safely
 * use it as a `<TransitionGroup>` source.
 */
export function useActiveFirstOrder<T extends ActiveFirstChip>(
  options: UseActiveFirstOrderOptions<T>
): ComputedRef<T[]> {
  return computed(() =>
    [...options.chips.value].sort((a, b) => {
      const aActive = options.isActive(a)
      const bActive = options.isActive(b)
      if (aActive !== bActive) return aActive ? -1 : 1
      return a.title.localeCompare(b.title)
    })
  )
}
