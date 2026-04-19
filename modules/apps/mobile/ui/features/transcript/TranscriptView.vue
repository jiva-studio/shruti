<template>
  <div class="transcript">
    <template v-for="(block, idx) in blocks" :key="idx">
      <div
        v-if="block.type === 'sentence'"
        class="block sentence"
        :class="{ active: isActive(block.start, block.end) }"
        @click="$emit('seek', block.start)"
      >
        <span v-if="block.speaker" class="speaker">{{ block.speaker }}: </span>
        <span class="text">{{ block.text }}</span>
      </div>

      <div
        v-else-if="block.type === 'verse:text'"
        class="block verse-text"
        :class="{ active: isActive(block.start, block.end) }"
        @click="$emit('seek', block.start)"
      >
        <p v-for="(line, i) in block.text" :key="i">{{ line }}</p>
      </div>

      <div
        v-else-if="block.type === 'verse:translation'"
        class="block verse-translation"
        :class="{ active: isActive(block.start, block.end) }"
        @click="$emit('seek', block.start)"
      >
        <p>{{ block.text }}</p>
      </div>

      <div v-else class="block paragraph-break" />
    </template>
  </div>
</template>

<script setup lang="ts">
/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

import type { UiTranscriptBlock } from "./types.js"

interface Props {
  blocks: readonly UiTranscriptBlock[]
  /** Current playback position, in seconds. Used to highlight the active block. */
  currentPosition?: number
}

const props = withDefaults(defineProps<Props>(), { currentPosition: 0 })
defineEmits<{ seek: [position: number] }>()

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function isActive(start: number, end: number): boolean {
  return props.currentPosition >= start && props.currentPosition < end
}
</script>

<style scoped>
.transcript {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 16px;
}

.block {
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 150ms ease;
}

.block:hover {
  background-color: var(--ion-color-step-100, rgba(0, 0, 0, 0.05));
}

.block.active {
  background-color: var(--ion-color-primary-tint, #4c8dff);
  color: var(--ion-color-primary-contrast, #ffffff);
}

.sentence .speaker {
  font-weight: 600;
}

.verse-text p {
  margin: 0;
  font-style: italic;
}

.verse-translation p {
  margin: 0;
}

.paragraph-break {
  height: 12px;
}
</style>
