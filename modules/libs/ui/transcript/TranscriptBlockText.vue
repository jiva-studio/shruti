<script setup lang="ts">
import { computed } from "vue"
import type { TranscriptBlock } from "@lib/catalog/types.js"
import { renderInlineMarkdown } from "./renderInlineMarkdown.js"
import VerseRefChip from "./VerseRefChip.vue"

const props = defineProps<{
  block: TranscriptBlock
}>()

const html = (text: string): string => renderInlineMarkdown(text)

// Reference label shown as a centered header above the verse (e.g. "BG 5.52").
const verseNo = computed(() => {
  const b = props.block
  if (b.type !== "verse:text" || !b.reference) return ""
  return b.reference.label ?? b.reference.tokens.join(".")
})
</script>

<template>
  <span v-if="block.type === 'sentence'" class="tx-sentence">
    <span v-html="html(block.text + ' ')" /><VerseRefChip
      v-if="block.reference"
      :reference="block.reference"
    />
  </span>
  <span v-else-if="block.type === 'verse:text'" class="tx-verse">
    <span v-if="verseNo" class="tx-verse-no">{{ verseNo }}</span>
    <span
      v-for="(line, i) in block.original ?? []"
      :key="'o' + i"
      class="tx-verse-original"
      v-html="html(line)"
    />
    <span v-for="(line, i) in block.text" :key="i" class="tx-verse-line" v-html="html(line)" />
    <span v-if="block.translation" class="tx-verse-translation" v-html="html(block.translation)" />
  </span>
  <span
    v-else-if="block.type === 'verse:translation'"
    class="tx-translation"
    v-html="html(block.text + ' ')"
  />
  <span
    v-else-if="block.type === 'marker'"
    class="tx-marker"
    v-html="'[' + html(block.text) + '] '"
  />
</template>

<style scoped>
.tx-verse {
  display: block;
  margin: 16px 0;
  text-align: center;
  font-family: var(--font-serif, serif);
  color: var(--ion-color-tertiary);
}

.tx-verse-no {
  display: block;
  margin-bottom: 4px;
  font-weight: 700;
  font-size: 0.85em;
  color: var(--ion-color-primary);
}

.tx-verse-original {
  display: block;
  line-height: 1.5;
  font-family: "Sanskrit2003", "Noto Sans Devanagari", var(--font-serif, serif);
}

.tx-verse-line {
  display: block;
  line-height: 1.6;
  font-style: italic;
  opacity: 0.85;
}

.tx-verse-translation {
  display: block;
  margin-top: 6px;
  font-style: normal;
  color: var(--ion-color-medium);
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
