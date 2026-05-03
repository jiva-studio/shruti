<template>
  <TextSelector
    :class="['transcript-text', { static: enableActiveProminence === false }]"
    dataset-field-start="data-time-start"
    dataset-field-end="data-time-end"
    @selecting="onSelecting"
    @selected="onSelected"
    @pick-start="emit('pickStart')"
  >
    <p
      v-for="(group, groupIdx) in groups"
      :key="groupIdx"
      :class="{ prompter: true, paragraph: isActiveGroup(group) }"
    >
      <Timestamp
        v-if="group.blocks[0]?.block.start && group.blocks[0].block.type !== 'verse:text'"
        :start="group.blocks[0]?.block.start"
        :duration="duration"
      />
      <TranscriptBlockRenderer
        v-for="(block, blockIdx) in group.blocks"
        :key="blockIdx"
        :block="block"
        :position="position"
        :display-speaker-icon="displaySpeakerIcons"
        :should-highlight-current="shouldHighlightCurrentSentence"
        :is-first-in-group="blockIdx === 0"
        @seek="(pos) => emit('seek', pos)"
      />
    </p>
  </TextSelector>
</template>

<script setup lang="ts">
import { toRefs } from "vue"
import Timestamp from "./Timestamp.vue"
import TextSelector from "./TextSelector.vue"
import TranscriptBlockRenderer from "./TranscriptBlockRenderer.vue"
import type { UiTranscriptBlocksGroup } from "./types.js"
import {
  useTranscriptSelection,
  type TextSelectedPayload,
} from "./composables/useTranscriptSelection.js"

export type TextSelectedEvent = TextSelectedPayload

const props = defineProps<{
  displaySpeakerIcons: boolean
  groups: readonly UiTranscriptBlocksGroup[]
  position: number
  duration: number
  shouldHighlightCurrentSentence: boolean
  /** See TranscriptDialog — false suppresses the prompter scaling. */
  enableActiveProminence?: boolean
}>()

const emit = defineEmits<{
  seek: [position: number]
  textSelected: [event: TextSelectedEvent]
  /** Propagates the long-press-on-selectable signal up to the controller. */
  pickStart: []
}>()

const { groups, position } = toRefs(props)
const { applySelectionRange, buildSelectedPayload, isActiveGroup } = useTranscriptSelection({
  groups,
  position,
})

function onSelecting(start: number, end: number): void {
  applySelectionRange(start, end)
}

function onSelected(start: number, end: number, event: TouchEvent): void {
  const payload = buildSelectedPayload(start, end, event)
  if (payload) emit("textSelected", payload)
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

.transcript-text.static .prompter,
.transcript-text.static .paragraph {
  transform: none;
  opacity: 1;
  transition: none;
}
</style>
