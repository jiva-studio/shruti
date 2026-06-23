<template>
  <span v-if="block.type === 'sentence'" class="tx-sentence">{{ block.text + ' ' }}</span>
  <span v-else-if="block.type === 'verse:text'" class="tx-verse">
    <span v-for="(line, i) in block.text" :key="i" class="tx-verse-line">{{ line }}</span>
  </span>
  <span v-else-if="block.type === 'verse:translation'" class="tx-translation">{{ block.text + ' ' }}</span>
</template>

<script setup lang="ts">
import type { TranscriptBlock } from '@lib/catalog/types.js'

defineProps<{
  block: TranscriptBlock
}>()
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
</style>
