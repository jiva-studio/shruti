<template>
  <span class="vref">
    <button type="button" class="vref-chip" :class="{ openable: hasVerse }" @click.stop="toggle">
      {{ verseNo }}
    </button>

    <!-- Popover above the chip. No backdrop; dismisses on any click
         (outside via the document listener, on the chip via toggle,
         on the card itself via @click). -->
    <span v-if="open" class="vref-card" @click="open = false">
      <span class="vref-no">{{ verseNo }}</span>
      <span
        v-for="(line, i) in reference.original ?? []"
        :key="'o' + i"
        class="vref-original"
        v-html="md(line)"
      />
      <span
        v-for="(line, i) in reference.transliteration ?? []"
        :key="'t' + i"
        class="vref-iast"
        v-html="md(line)"
      />
      <span
        v-if="reference.translation"
        class="vref-translation"
        v-html="md(reference.translation)"
      />
    </span>
  </span>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue"
import type { BlockReference } from "@lib/catalog/types.js"
import { renderInlineMarkdown } from "./renderInlineMarkdown.js"

const props = defineProps<{
  reference: BlockReference
}>()

const open = ref(false)
const verseNo = computed(() => props.reference.label ?? props.reference.tokens.join("."))
const hasVerse = computed(
  () =>
    !!(
      props.reference.original?.length ||
      props.reference.transliteration?.length ||
      props.reference.translation
    )
)
const md = (text: string): string => renderInlineMarkdown(text)

function toggle(): void {
  if (hasVerse.value) open.value = !open.value
}
function close(): void {
  open.value = false
}

// Close on any click elsewhere. The opening click is @click.stop so it never
// reaches the document, so the popover doesn't immediately self-close.
watch(open, (isOpen) => {
  if (typeof document === "undefined") return
  if (isOpen) document.addEventListener("click", close)
  else document.removeEventListener("click", close)
})
onUnmounted(() => {
  if (typeof document !== "undefined") document.removeEventListener("click", close)
})
</script>

<style scoped>
.vref {
  position: relative;
  display: inline-block;
}

.vref-chip {
  display: inline;
  margin: 0 0.15em;
  padding: 0 0.35em;
  border: none;
  border-radius: 4px;
  font-size: 0.72em;
  font-weight: 700;
  font-family: inherit;
  line-height: 1.4;
  vertical-align: 0.08em;
  white-space: nowrap;
  background: rgba(var(--ion-color-primary-rgb), 0.14);
  color: var(--ion-color-primary);
}
.vref-chip.openable {
  cursor: pointer;
}
.vref-chip.openable:hover {
  background: rgba(var(--ion-color-primary-rgb), 0.26);
}

.vref-card {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 50;
  width: max-content;
  max-width: min(90vw, 30rem);
  max-height: 60vh;
  overflow-y: auto;
  padding: 0.9rem 1.1rem;
  border-radius: 10px;
  background: var(--ion-background-color, #fff);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.22);
  text-align: center;
  white-space: normal;
  cursor: default;
  font-family: var(--font-serif, serif);
  color: var(--ion-color-tertiary);
}

.vref-no {
  display: block;
  margin-bottom: 0.45rem;
  font-weight: 700;
  font-size: 0.9rem;
  color: var(--ion-color-primary);
}
.vref-original {
  display: block;
  line-height: 1.5;
  font-family: "Sanskrit2003", "Noto Sans Devanagari", var(--font-serif, serif);
}
.vref-iast {
  display: block;
  margin-top: 0.1rem;
  line-height: 1.6;
  font-style: italic;
  opacity: 0.85;
}
.vref-translation {
  display: block;
  margin-top: 0.55rem;
  color: var(--ion-color-medium);
}
</style>
