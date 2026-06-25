<template>
  <span v-if="block.type === 'sentence'" class="tx-sentence" v-html="html(block.text + ' ')" />
  <span v-else-if="block.type === 'verse:text'" class="tx-verse">
    <span v-for="(line, i) in block.text" :key="i" class="tx-verse-line" v-html="html(line)" />
  </span>
  <span v-else-if="block.type === 'verse:translation'" class="tx-translation" v-html="html(block.text + ' ')" />
  <span v-else-if="block.type === 'marker'" class="tx-marker" v-html="'[' + html(block.text) + '] '" />
</template>

<script setup lang="ts">
import type { TranscriptBlock } from '@lib/catalog/types.js'
import { renderInlineMarkdown } from './renderInlineMarkdown.js'

defineProps<{
  block: TranscriptBlock
}>()

const html = (text: string): string => renderInlineMarkdown(text)
</script>

<style scoped>
.tx-verse {
  display: block;
  margin: 10px 0;
  padding-left: 14px;
  border-left: 3px solid var(--ion-color-primary);
  font-family: var(--font-serif, serif);
  color: var(--ion-color-tertiary);
}

.tx-verse-line {
  display: block;
  line-height: 1.6;
}

.tx-translation {
  font-style: italic;
  color: var(--ion-color-medium);
}

.tx-marker {
  color: var(--ion-color-medium);
  font-style: italic;
  opacity: 0.7;
}
</style>
