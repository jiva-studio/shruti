import { ref, type Ref } from "vue"
import type { UiTranscriptBlocksGroup, UiTranscriptBlockView } from "../types.js"

/** Block kinds whose text contributes to the selected-text payload. */
export const SELECTABLE_BLOCK_TYPES = ["sentence", "verse:translation"] as const

export interface UseTranscriptSelectionOptions {
  groups: Ref<readonly UiTranscriptBlocksGroup[]>
  position: Ref<number>
}

export interface TextSelectedPayload {
  text: string
  timeStart: number
  timeEnd: number
  event: TouchEvent
}

/** Inclusive time-range that defines what is currently selected. */
export interface SelectionRange {
  start: number
  end: number
}

export interface UseTranscriptSelectionReturn {
  /** Active selection range, or `null` when nothing is selected. */
  selectionRange: Ref<SelectionRange | null>
  /** Set the active selection range to `[start..end]`. */
  applySelectionRange: (start: number, end: number) => void
  /** Clear the active selection. */
  clearSelection: () => void
  /** Build a `{ text, timeStart, timeEnd }` payload for emission. */
  buildSelectedPayload: (
    start: number,
    end: number,
    event: TouchEvent
  ) => TextSelectedPayload | null
  /** True when the block falls within the active selection range. */
  isSelected: (block: UiTranscriptBlockView) => boolean
  /** True when the block contains the current playhead position. */
  isCurrent: (block: UiTranscriptBlockView) => boolean
  /** True when any block in the group brackets the current playhead position. */
  isActiveGroup: (group: UiTranscriptBlocksGroup) => boolean
}

/**
 * Encapsulates transcript selection state.
 *
 * Selection is stored as a single reactive time-range; each renderer
 * derives its own "selected" flag from that range. The previous
 * implementation mutated a `selected` boolean on each block, but those
 * blocks come from a `computed()` returning plain objects — the
 * mutations never triggered a re-render, so the live drag-selection
 * highlight was effectively invisible.
 */
export function useTranscriptSelection(
  options: UseTranscriptSelectionOptions
): UseTranscriptSelectionReturn {
  const selectionRange = ref<SelectionRange | null>(null)

  function applySelectionRange(start: number, end: number): void {
    selectionRange.value = { start, end }
  }

  function clearSelection(): void {
    selectionRange.value = null
  }

  function buildSelectedPayload(
    start: number,
    end: number,
    event: TouchEvent
  ): TextSelectedPayload | null {
    const text = options.groups.value
      .flatMap((group) => group.blocks)
      .filter((block) => block.block.start >= start && block.block.end <= end)
      .filter((block) => (SELECTABLE_BLOCK_TYPES as readonly string[]).includes(block.block.type))
      .map((block) =>
        block.block.type === "sentence" || block.block.type === "verse:translation"
          ? block.block.text
          : ""
      )
      .join(" ")

    if (!text) return null
    return { text, timeStart: start, timeEnd: end, event }
  }

  function isSelected(block: UiTranscriptBlockView): boolean {
    const r = selectionRange.value
    if (!r) return false
    return block.block.start >= r.start && block.block.end <= r.end
  }

  function isCurrent(block: UiTranscriptBlockView): boolean {
    const pos = options.position.value
    return block.block.start <= pos && block.block.end >= pos
  }

  function isActiveGroup(group: UiTranscriptBlocksGroup): boolean {
    const first = group.blocks[0]?.block
    const last = group.blocks[group.blocks.length - 1]?.block
    if (!first || !last) return false
    const pos = options.position.value
    return first.start <= pos && last.end >= pos
  }

  return {
    selectionRange,
    applySelectionRange,
    clearSelection,
    buildSelectedPayload,
    isSelected,
    isCurrent,
    isActiveGroup,
  }
}
