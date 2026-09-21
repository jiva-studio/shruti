<script setup lang="ts">
import { computed } from "vue"
import SentenceBlock from "./SentenceBlock.vue"
import VerseTextBlock from "./VerseTextBlock.vue"
import VerseTextInlineBlock from "./VerseTextInlineBlock.vue"
import VerseTranslationBlock from "./VerseTranslationBlock.vue"
import MarkerBlock from "./MarkerBlock.vue"
import type { UiTranscriptBlockView } from "./types.js"
import { timeRangesIntersect } from "./timeRange.js"

const props = defineProps<{
  block: UiTranscriptBlockView
  /** Current playhead position in milliseconds (matches block.start/end units). */
  position: number
  /**
   * True when this block's transcript is a dialogue. Gates every dialogue
   * affordance on a sentence block: the speaker icon, and the dash + line break
   * at a speaker change. On a monologue `speakerChanged` still fires at each
   * paragraph start (the grouper resets its running speaker), so without this
   * gate every paragraph opened with a stray "–".
   */
  displaySpeakerIcon: boolean
  /** When true, applies the `current` highlight class to the active block. */
  shouldHighlightCurrent: boolean
  /** When true, this block is the first inside its paragraph group. */
  isFirstInGroup: boolean
  /** Active text-selection range, or null when nothing is selected. */
  selectionRange?: { start: number; end: number } | null
}>()

const emit = defineEmits<{
  seek: [position: number]
  /**
   * The user tapped a block that is covered by one or more saved notes.
   * The parent opens the selection popover anchored to `event` and uses
   * `noteIds` to drive the Delete action. Suppresses the seek emission
   * for this tap — for highlighted spans we treat tap as "open contextual
   * actions for this note", not "seek to this point".
   */
  "note-tapped": [payload: { noteIds: readonly string[]; event: MouseEvent }]
}>()

const isCurrent = computed(
  () => props.block.block.start <= props.position && props.block.block.end >= props.position
)

const referenceVisible = computed(
  () =>
    props.block.block.start <= props.position + 1000 &&
    props.block.block.end >= props.position - 1000
)

const isInSelection = computed(() => {
  const r = props.selectionRange
  if (!r) return false
  return timeRangesIntersect(props.block.block, r)
})

const stateClasses = computed(() => ({
  current: props.shouldHighlightCurrent && isCurrent.value,
  highlighted: props.block.bookmarked,
  selected: isInSelection.value,
}))

/**
 * Tap routing:
 *  - On a highlighted block with at least one resolved note id, fire
 *    `noteTapped` so the dialog opens the popover with the Delete
 *    affordance (issue #478). The seek is suppressed — for a saved note,
 *    the user's intent is "act on this note", not "seek here".
 *  - Anywhere else (plain sentence, verse, or a bookmarked block whose
 *    notes have no ids — preview mode), fall back to the legacy seek.
 */
function onBlockClick(event: MouseEvent): void {
  if (props.block.bookmarked && props.block.noteIds.length > 0) {
    emit("note-tapped", { noteIds: props.block.noteIds, event })
    return
  }
  emit("seek", props.block.block.start + 1)
}
</script>

<template>
  <SentenceBlock
    v-if="block.block.type === 'sentence'"
    :text="block.block.text"
    :icon="displaySpeakerIcon ? block.icon : undefined"
    :reference="block.block.reference"
    :show-dash="displaySpeakerIcon && block.block.speakerChanged"
    :new-line="displaySpeakerIcon && block.block.speakerChanged && !isFirstInGroup"
    :reference-visible="referenceVisible"
    :lang="block.language"
    :class="stateClasses"
    :data-time-start="block.block.start"
    :data-time-end="block.block.end"
    :data-speaker="block.block.speaker"
    @click="onBlockClick"
  />

  <VerseTextBlock
    v-else-if="block.block.type === 'verse:text' && block.block.text.length > 1"
    :lines="block.block.text"
    :reference="block.block.reference"
    :original="block.block.original"
    :translation="block.block.translation"
    :class="stateClasses"
    :data-time-start="block.block.start"
    :data-time-end="block.block.end"
    @click="onBlockClick"
  />

  <VerseTextInlineBlock
    v-else-if="block.block.type === 'verse:text'"
    :text="block.block.text[0] ?? ''"
    :reference="block.block.reference"
    :reference-visible="referenceVisible"
    :class="stateClasses"
    :data-time-start="block.block.start"
    :data-time-end="block.block.end"
    @click="onBlockClick"
  />

  <VerseTranslationBlock
    v-else-if="block.block.type === 'verse:translation'"
    :text="block.block.text"
    :class="stateClasses"
    :data-time-start="block.block.start"
    :data-time-end="block.block.end"
    @click="onBlockClick"
  />

  <MarkerBlock
    v-else-if="block.block.type === 'marker'"
    :text="block.block.text"
    :class="stateClasses"
    :data-time-start="block.block.start"
    :data-time-end="block.block.end"
    @click="onBlockClick"
  />
</template>

<style scoped>
.current {
  transition: all 0.4s;
  /* Pale saffron — reads as "lit" against the dark immersive
     background and noticeably brighter than its plain-white siblings
     inside the active paragraph. var(--ion-color-primary) resolves to
     a saffron that's darker than the surrounding white prompter text,
     which made the currently-playing line look dimmer than the rest. */
  color: #ffc78a !important;
}

/* Saved note (bookmarked) — wavy underline in warning colour. */
.highlighted {
  text-decoration: underline wavy var(--ion-color-warning);
  text-decoration-skip-ink: none;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
}

/* Drag selection (in progress + popover open) — same wavy underline but
   in primary colour, so the user can distinguish what they're currently
   selecting from what was already saved. Stacking is clean: two
   overlapping notes paint two underlines instead of one muddy fill. */
.selected {
  text-decoration: underline wavy var(--ion-color-primary);
  text-decoration-skip-ink: none;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
}

/* When a block is both .selected (just dragged) and .highlighted (already
   saved as a note), prefer the drag colour — it signals "this is what
   you're acting on right now". */
.highlighted.selected {
  text-decoration-color: var(--ion-color-primary);
}
</style>
