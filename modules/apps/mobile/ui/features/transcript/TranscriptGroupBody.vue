<script setup lang="ts">
import Timestamp from "./Timestamp.vue"
import TranscriptBlockRenderer from "./TranscriptBlockRenderer.vue"
import type { UiTranscriptBlocksGroup } from "./types.js"

defineProps<{
  group: UiTranscriptBlocksGroup
  multiSpeakerLanguages: ReadonlySet<string>
  position: number
  duration: number
  shouldHighlightCurrentSentence: boolean
  enableActiveProminence: boolean
  selectionRange?: { start: number; end: number } | null
}>()

const emit = defineEmits<{
  seek: [position: number]
  "note-tapped": [event: { noteIds: readonly string[]; event: MouseEvent }]
}>()
</script>

<template>
  <!-- Sentence-paired: each language on its own line (original on top,
       translation beneath); the timestamp sits on the first line. -->
  <template v-if="group.paired">
    <span v-for="(block, blockIdx) in group.blocks" :key="blockIdx" class="paired-line">
      <Timestamp
        v-if="blockIdx === 0 && block.block.start && block.block.type !== 'verse:text'"
        :start="block.block.start"
        :duration="duration"
        :show-remaining="enableActiveProminence"
      />
      <TranscriptBlockRenderer
        :block="block"
        :position="position"
        :display-speaker-icon="multiSpeakerLanguages.has(block.language)"
        :should-highlight-current="shouldHighlightCurrentSentence"
        :is-first-in-group="true"
        :selection-range="selectionRange"
        @seek="(pos) => emit('seek', pos)"
        @note-tapped="(payload) => emit('note-tapped', payload)"
      />
    </span>
  </template>
  <template v-else>
    <Timestamp
      v-if="group.blocks[0]?.block.start && group.blocks[0].block.type !== 'verse:text'"
      :start="group.blocks[0]?.block.start"
      :duration="duration"
      :show-remaining="enableActiveProminence"
    />
    <TranscriptBlockRenderer
      v-for="(block, blockIdx) in group.blocks"
      :key="blockIdx"
      :block="block"
      :position="position"
      :display-speaker-icon="multiSpeakerLanguages.has(block.language)"
      :should-highlight-current="shouldHighlightCurrentSentence"
      :is-first-in-group="blockIdx === 0"
      :selection-range="selectionRange"
      @seek="(pos) => emit('seek', pos)"
      @note-tapped="(payload) => emit('note-tapped', payload)"
    />
  </template>
</template>

<style scoped>
.paired-line {
  display: block;
  transition: all 0.4s ease-in-out;
}
.paired-line:not(:first-child) {
  opacity: 0.7;
}
</style>
