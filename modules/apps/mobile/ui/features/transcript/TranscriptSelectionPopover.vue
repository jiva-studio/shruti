<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { IonPopover } from "@ionic/vue"
import SelectionActions from "./SelectionActions.vue"
import type { TextSelectedEvent } from "./TranscriptText.vue"

export type SelectionAction = "copy" | "bookmark" | "share" | "delete" | "ask"

/**
 * Input describing a tap on an already-highlighted span. The popover
 * opens anchored to the click coordinates and lights up the Delete
 * button via `SelectionActions`' `mode="existing"`.
 */
export interface ExistingNoteSelection {
  noteIds: readonly string[]
  /** Anchor used by IonPopover. Same role as `TextSelectedEvent.event`. */
  event: MouseEvent | TouchEvent
  /** Optional text payload — currently unused for tap (no live selection
   *  range) but kept for symmetry with `TextSelectedEvent`. */
  text?: string
}

const props = defineProps<{
  /**
   * Selection event triggered by `TranscriptText`. Setting it opens the
   * popover anchored to the touch event; setting it back to `undefined`
   * closes the popover externally.
   */
  selection: TextSelectedEvent | undefined
  /**
   * Set instead of (or alongside) `selection` when the user tapped an
   * already-saved highlighted span. Drives `mode="existing"` so the
   * Delete button appears in the action row.
   */
  existing?: ExistingNoteSelection | undefined
}>()

const emit = defineEmits<{
  action: [
    event: {
      action: SelectionAction
      text: string
      timeStart: number
      timeEnd: number
      /** Populated only when `action === "delete"` — never empty in that
       *  case. For copy/bookmark/share this stays an empty array. */
      noteIds: readonly string[]
    },
  ]
  dismissed: []
}>()

const isOpen = ref(false)
const anchorEvent = ref<MouseEvent | TouchEvent>()
let lastAction: SelectionAction | null = null

/**
 * Resolves to `"existing"` whenever the parent passed an
 * `ExistingNoteSelection` (tap-on-highlight path); otherwise `"selection"`
 * for the drag-select / fresh-bookmark path. `SelectionActions` reads
 * this to decide between the Copy/Bookmark/Share row and the
 * Copy/Share/Delete row.
 */
const mode = computed<"selection" | "existing">(() => (props.existing ? "existing" : "selection"))

watch(
  () => [props.selection, props.existing] as const,
  ([nextSelection, nextExisting]) => {
    lastAction = null
    if (nextExisting) {
      anchorEvent.value = nextExisting.event
      isOpen.value = true
    } else if (nextSelection) {
      anchorEvent.value = nextSelection.event
      isOpen.value = true
    } else {
      isOpen.value = false
    }
  }
)

function onActionClicked(action: SelectionAction): void {
  lastAction = action
  isOpen.value = false
  // Existing-note path (tap-on-highlight) — no selected text/range; we
  // only know the underlying note ids.
  if (props.existing) {
    emit("action", {
      action,
      text: props.existing.text ?? "",
      timeStart: 0,
      timeEnd: 0,
      noteIds: props.existing.noteIds,
    })
    return
  }
  if (!props.selection) return
  emit("action", {
    action,
    text: props.selection.text,
    timeStart: props.selection.timeStart,
    timeEnd: props.selection.timeEnd,
    noteIds: [],
  })
}

function onDismiss(): void {
  isOpen.value = false
  if (!lastAction && (props.selection || props.existing)) {
    emit("dismissed")
  }
}
</script>

<template>
  <IonPopover
    :translucent="true"
    :animated="true"
    :arrow="false"
    :is-open="isOpen"
    :event="anchorEvent"
    @did-dismiss="onDismiss"
  >
    <SelectionActions :mode="mode" @action="onActionClicked" />
  </IonPopover>
</template>
