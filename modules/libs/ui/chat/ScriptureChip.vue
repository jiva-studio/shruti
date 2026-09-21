<script setup lang="ts">
import { computed } from "vue"

// Inline pill shown when a verse / chapter citation has no block body yet
// (pre-feature history, or the payload hasn't streamed). Shared by VerseCard
// and ChapterCard — they only differ in the caption's max width. The icon
// defaults to an inline SVG (no icon-library dependency, so the component is
// reusable outside the Ionic/@tabler app); a parent may override via the
// `icon` slot.
const props = withDefaults(
  defineProps<{
    caption: string
    ariaLabel?: string
    captionMaxWidth?: string
  }>(),
  { captionMaxWidth: "18ch" }
)

defineEmits<{ tap: [] }>()

const captionStyle = computed(() => ({ maxWidth: props.captionMaxWidth }))
</script>

<template>
  <span
    role="button"
    tabindex="0"
    class="scripture-chip"
    :aria-label="ariaLabel"
    @click="$emit('tap')"
    @keydown.enter.space.prevent="$emit('tap')"
  >
    <span class="scripture-chip-icon">
      <slot name="icon">
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M19 4v16h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2h12" />
          <path d="M19 16h-12a2 2 0 0 0 -2 2" />
          <path d="M9 8h6" />
        </svg>
      </slot>
    </span>
    <span class="scripture-chip-caption" :style="captionStyle">{{ caption }}</span>
  </span>
</template>

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
