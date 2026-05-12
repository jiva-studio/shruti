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

const stateClasses = computed(() => ({
  current: props.shouldHighlightCurrent && isCurrent.value,
  highlighted: props.block.bookmarked,
  selected: props.block.selected,
}))
</script>

<style scoped>
.current {
  transition: all 0.4s;
  color: var(--ion-color-primary) !important;
}

.highlighted {
  color: var(--ion-color-warning);
}

.selected {
  /* Subtle theme-tinted highlight: enough to draw the eye to the picked
     sentence without overpowering the prompter or fighting the .current
     accent on the active block. */
  background-color: rgba(var(--ion-color-primary-rgb), 0.24);
  border-radius: 3px;
  box-shadow: 0 0 0 2px rgba(var(--ion-color-primary-rgb), 0.24);
}
</style>
