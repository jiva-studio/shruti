<template>
  <SentenceBlock
    v-if="block.block.type === 'sentence'"
    :text="block.block.text"
    :icon="displaySpeakerIcon ? block.icon : undefined"
    :reference="block.block.reference"
    :show-dash="block.block.speakerChanged"
    :new-line="block.block.speakerChanged && !isFirstInGroup"
    :reference-visible="referenceVisible"
    :lang="block.language"
    :class="stateClasses"
    :data-time-start="block.block.start"
    :data-time-end="block.block.end"
    :data-speaker="block.block.speaker"
    @click="emit('seek', block.block.start + 1)"
  />

  <VerseTextBlock
    v-else-if="block.block.type === 'verse:text' && block.block.text.length > 1"
    :lines="block.block.text"
    :reference="block.block.reference"
    :class="stateClasses"
    :data-time-start="block.block.start"
    :data-time-end="block.block.end"
    @click="emit('seek', block.block.start + 1)"
  />

  <VerseTextInlineBlock
    v-else-if="block.block.type === 'verse:text'"
    :text="block.block.text[0] ?? ''"
    :reference="block.block.reference"
    :reference-visible="referenceVisible"
    :class="stateClasses"
    :data-time-start="block.block.start"
    :data-time-end="block.block.end"
    @click="emit('seek', block.block.start + 1)"
  />

  <VerseTranslationBlock
    v-else-if="block.block.type === 'verse:translation'"
    :text="block.block.text"
    :class="stateClasses"
    :data-time-start="block.block.start"
    :data-time-end="block.block.end"
    @click="emit('seek', block.block.start + 1)"
  />
</template>

<script setup lang="ts">
import { computed } from "vue"
import SentenceBlock from "./SentenceBlock.vue"
import VerseTextBlock from "./VerseTextBlock.vue"
import VerseTextInlineBlock from "./VerseTextInlineBlock.vue"
import VerseTranslationBlock from "./VerseTranslationBlock.vue"
import type { UiTranscriptBlockView } from "./types.js"

const props = defineProps<{
  block: UiTranscriptBlockView
  /** Current playhead position in milliseconds (matches block.start/end units). */
  position: number
  /** When true, renders the speaker icon for sentence blocks. */
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
  return props.block.block.start >= r.start && props.block.block.end <= r.end
})

const stateClasses = computed(() => ({
  current: props.shouldHighlightCurrent && isCurrent.value,
  highlighted: props.block.bookmarked,
  selected: isInSelection.value,
}))
</script>

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
