<template>
  <p
    v-for="(section, idx) in sections"
    :key="idx"
    :class="{
      'prompter': true,
      'paragraph': section.blocks[0].start <= time && section.blocks[section.blocks.length-1].end >= time
    }"
  >
    <Timestamp
      :start="section.blocks[0].start"
    />
    <component
      :is="'span'"
      v-for="(block, index) in section.blocks"
      :key="index"
      :class="{
        'highlight': block.start <= time && block.end >= time
      }"
      @click="emit('rewind', block.start)"
    >
      {{ block.text + " " }}
    </component>
  </p>
</template>

<script setup lang="ts">
import Timestamp from './Sections/Timestamp.vue'

export type TranscriptSection = {
  blocks: TranscriptBlock[]
}

export type TranscriptBlock = {
  type: 'sentence' | 'paragraph'
  text: string
  start: number
  end: number
}

defineProps<{
  sections: TranscriptSection[]
  time: number
}>()

const emit = defineEmits<{
  rewind: [time: number]
}>()
</script>


<style scoped>
ion-modal ion-content {
  --background: #1D263B;
}

ion-modal ion-toolbar {
  --background: #1D263B;
}

.prompter {
  color: white;
  transition: all 0.5s;
  transform: scale(0.95);
  opacity: .5;
}

.paragraph {
  word-wrap: break-word;
  transform: scale(1.03);
  opacity: 1;
}

.highlight {
  transition: all 0.5s;
  color: #FF6B6B;
}
</style>