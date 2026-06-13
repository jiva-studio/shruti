<template>
  <span
    role="button"
    tabindex="0"
    class="scripture-chip"
    :aria-label="ariaLabel"
    @click="$emit('tap')"
    @keydown.enter.space.prevent="$emit('tap')"
  >
    <IconBook2 :size="14" stroke="1.75" class="scripture-chip-icon" />
    <span class="scripture-chip-caption" :style="{ maxWidth: captionMaxWidth }">{{ caption }}</span>
  </span>
</template>

<script setup lang="ts">
// Inline pill shown when a verse / chapter citation has no block body yet
// (pre-feature history, or the payload hasn't streamed). Shared by VerseCard
// and ChapterCard — they only differ in the caption's max width.
import { IconBook2 } from "@tabler/icons-vue"

withDefaults(
  defineProps<{
    caption: string
    ariaLabel?: string
    captionMaxWidth?: string
  }>(),
  { captionMaxWidth: "18ch" }
)

defineEmits<{ tap: [] }>()
</script>

<style scoped>
.scripture-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  margin: 0 2px;
  border-radius: 999px;
  border: 1px solid var(--ion-color-primary);
  background: rgba(var(--ion-color-primary-rgb), 0.08);
  color: var(--ion-color-primary);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.3;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  vertical-align: baseline;
  transition: background 0.15s ease;
}
.scripture-chip:hover,
.scripture-chip:focus-visible {
  background: rgba(var(--ion-color-primary-rgb), 0.18);
  outline: none;
}
.scripture-chip-icon {
  flex: 0 0 auto;
}
.scripture-chip-caption {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
