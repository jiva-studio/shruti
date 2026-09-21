<script setup lang="ts">
import { IconChevronRight } from "@tabler/icons-vue"

/**
 * The shared section title row for the Search shelves: a title (optionally
 * "#"-prefixed for topics) and a right-side action — the built-in "see all"
 * chevron, or anything passed via the `action` slot (e.g. the "all lectures"
 * pill). A plain flex row, NOT IonListHeader, so every section header renders at
 * the same height and the gap to its content is identical everywhere.
 */
defineProps<{
  title: string
  hashtag?: boolean
  seeAll?: boolean
  seeAllLabel?: string
}>()

const emit = defineEmits<{ more: [] }>()
</script>

<template>
  <div class="section-header">
    <span class="section-title"><span v-if="hashtag" class="hash">#</span>{{ title }}</span>
    <slot name="action">
      <button
        v-if="seeAll"
        type="button"
        class="section-more"
        :aria-label="seeAllLabel"
        @click="emit('more')"
      >
        <IconChevronRight :size="20" />
      </button>
    </slot>
  </div>
</template>

<style scoped>
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 16px 10px;
}

.section-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 1.15rem;
  font-weight: 700;
  line-height: 1.2;
  color: var(--ion-text-color);
}

.section-title .hash {
  color: var(--ion-color-medium, #999);
  margin-inline-end: 2px;
}

.section-more {
  flex: none;
  display: flex;
  align-items: center;
  appearance: none;
  border: none;
  padding: 0;
  background: transparent;
  color: var(--ion-color-medium);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
</style>
