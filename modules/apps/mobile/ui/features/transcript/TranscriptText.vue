<template>
  <TextSelector
    class="transcript-text"
    dataset-field-start="data-time-start"
    dataset-field-end="data-time-end"
    @selecting="onSelecting"
    @selected="onSelected"
    @pick-start="emit('pickStart')"
  >
    <p
      v-for="(section, idx) in blockGroups"
      :key="idx"
      :class="{
        prompter: true,
        paragraph: isActiveGroup(section),
      }"
    >
      <Timestamp
        v-if="section.blocks[0]?.block.start && section.blocks[0].block.type !== 'verse:text'"
        :start="section.blocks[0]?.block.start"
        :duration="duration"
      />
      <template v-for="(block, blockIdx) in section.blocks" :key="blockIdx">
        <SentenceBlock
          v-if="block.block.type === 'sentence'"
          :text="block.block.text"
          :icon="showSpeakerIcons ? block.icon : undefined"
          :reference="block.block.reference"
          :show-dash="block.block.speakerChanged"
          :new-line="block.block.speakerChanged && blockIdx !== 0"
          :reference-visible="block.block.start <= position + 1 && block.block.end >= position - 1"
          :lang="block.language"
          :class="{
            current: highlightCurrentSentence && isCurrent(block),
            highlighted: block.bookmarked,
            selected: block.selected,
          }"
          :data-time-start="block.block.start"
          :data-time-end="block.block.end"
          :data-speaker="block.block.type === 'sentence' ? block.block.speaker : undefined"
          @click="emit('seek', block.block.start + 0.01)"
        />

        <VerseTextBlock
          v-if="block.block.type === 'verse:text' && block.block.text.length > 1"
          :lines="block.block.text"
          :reference="block.block.reference"
          :class="{
            current: highlightCurrentSentence && isCurrent(block),
            highlighted: block.bookmarked,
            selected: block.selected,
          }"
          :data-time-start="block.block.start"
          :data-time-end="block.block.end"
          @click="emit('seek', block.block.start + 0.01)"
        />

        <VerseTextInlineBlock
          v-if="block.block.type === 'verse:text' && block.block.text.length <= 1"
          :text="block.block.text[0] ?? ''"
          :reference="block.block.reference"
          :reference-visible="block.block.start <= position + 1 && block.block.end >= position - 1"
          :class="{
            current: highlightCurrentSentence && isCurrent(block),
            highlighted: block.bookmarked,
            selected: block.selected,
          }"
          :data-time-start="block.block.start"
          :data-time-end="block.block.end"
          @click="emit('seek', block.block.start + 0.01)"
        />

        <VerseTranslationBlock
          v-if="block.block.type === 'verse:translation'"
          :text="block.block.text"
          :class="{
            current: highlightCurrentSentence && isCurrent(block),
            highlighted: block.bookmarked,
            selected: block.selected,
          }"
          :data-time-start="block.block.start"
          :data-time-end="block.block.end"
          @click="emit('seek', block.block.start + 0.01)"
        />
      </template>
    </p>
  </TextSelector>
</template>

<script setup lang="ts">
import SentenceBlock from "./SentenceBlock.vue"
import VerseTextBlock from "./VerseTextBlock.vue"
import VerseTextInlineBlock from "./VerseTextInlineBlock.vue"
import VerseTranslationBlock from "./VerseTranslationBlock.vue"
import Timestamp from "./Timestamp.vue"
import TextSelector from "./TextSelector.vue"
import type { UiTranscriptBlocksGroup, UiTranscriptBlockView } from "./types.js"

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

export type TextSelectedEvent = {
  text: string
  timeStart: number
  timeEnd: number
  event: TouchEvent
}

const props = defineProps<{
  showSpeakerIcons: boolean
  blockGroups: readonly UiTranscriptBlocksGroup[]
  position: number
  duration: number
  highlightCurrentSentence: boolean
}>()

const emit = defineEmits<{
  seek: [position: number]
  textSelected: [event: TextSelectedEvent]
  /** Propagates the long-press-on-selectable signal up to the controller. */
  pickStart: []
}>()

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onSelecting(start: number, end: number) {
  for (const group of props.blockGroups) {
    for (const b of group.blocks) {
      b.selected = b.block.start >= start && b.block.end <= end
    }
  }
}

function onSelected(start: number, end: number, event: TouchEvent) {
  const selectableBlocks = ["sentence", "verse:translation"]
  const selectedText = props.blockGroups
    .flatMap((g) => g.blocks)
    .filter((b) => b.block.start >= start && b.block.end <= end)
    .filter((b) => selectableBlocks.includes(b.block.type))
    .map((b) =>
      b.block.type === "sentence" || b.block.type === "verse:translation" ? b.block.text : ""
    )
    .join(" ")

  if (selectedText) {
    emit("textSelected", { text: selectedText, timeStart: start, timeEnd: end, event })
  }
}

function isActiveGroup(group: UiTranscriptBlocksGroup): boolean {
  const first = group.blocks[0]?.block
  const last = group.blocks[group.blocks.length - 1]?.block
  if (!first || !last) return false
  return first.start <= props.position && last.end >= props.position
}

function isCurrent(b: UiTranscriptBlockView): boolean {
  return b.block.start <= props.position && b.block.end >= props.position
}
</script>

<style scoped>
.transcript-text {
  text-align: justify;
  text-justify: inter-word;
  hyphens: auto;
  -moz-hyphens: auto;
}

span {
  transition: all 0.4s ease-in-out;
}

.prompter {
  color: white;
  transition: all 0.4s;
  transform: scale(0.95);
  opacity: 0.5;
  position: relative;
}

.paragraph {
  word-wrap: break-word;
  transform: scale(1.01);
  opacity: 1;
}

.current {
  transition: all 0.4s;
  color: #ff6b6b !important;
}

.highlighted {
  color: #c77dff;
}

.selected {
  color: #ffffff !important;
  background-color: #9d4edd;
}
</style>
