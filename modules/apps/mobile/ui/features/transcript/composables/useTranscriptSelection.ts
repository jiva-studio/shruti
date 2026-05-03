import type { Ref } from "vue"
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

export interface UseTranscriptSelectionReturn {
  /** Mark blocks within `[start..end]` as selected; clears the rest. */
  applySelectionRange: (start: number, end: number) => void
  /** Clear the `selected` flag on every block. */
  clearSelection: () => void
  /** Build a `{ text, timeStart, timeEnd }` payload for emission. */
  buildSelectedPayload: (
    start: number,
    end: number,
    event: TouchEvent
  ) => TextSelectedPayload | null
  /** True when the block contains the current playhead position. */
  isCurrent: (block: UiTranscriptBlockView) => boolean
  /** True when any block in the group brackets the current playhead position. */
  isActiveGroup: (group: UiTranscriptBlocksGroup) => boolean
}

/**
 * Encapsulates transcript selection state. Mutates the `selected` flag on
 * the input blocks (parent-owned data) — this matches the existing data
 * flow but the mutation is now isolated to a single place so the
 * coupling is visible.
 */
export function useTranscriptSelection(
  options: UseTranscriptSelectionOptions
): UseTranscriptSelectionReturn {
  function applySelectionRange(start: number, end: number): void {
    for (const group of options.groups.value) {
      for (const block of group.blocks) {
        block.selected = block.block.start >= start && block.block.end <= end
      }
    }
  }

  function clearSelection(): void {
    for (const group of options.groups.value) {
      for (const block of group.blocks) {
        if (block.selected) block.selected = false
      }
    }
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

  return { applySelectionRange, clearSelection, buildSelectedPayload, isCurrent, isActiveGroup }
}
