<script setup lang="ts">
import CollectionCard from "./CollectionCard.vue"

/**
 * Horizontal swipeable carousel of collection cards. Presentation-only — the
 * parent (a group section) supplies the already-resolved items and decides what
 * a tap opens.
 */
export interface CarouselItem {
  readonly id: string
  readonly name: string
  readonly coverUrl?: string
}

defineProps<{ items: readonly CarouselItem[]; hashtag?: boolean }>()
const emit = defineEmits<{ (e: "select", id: string): void }>()
</script>

<template>
  <div v-if="items.length" class="collections-carousel">
    <CollectionCard
      v-for="c in items"
      :key="c.id"
      :name="c.name"
      :cover-url="c.coverUrl"
      :hashtag="hashtag"
      @click="emit('select', c.id)"
    />
  </div>
</template>

<style scoped>
.collections-carousel {
  display: flex;
  gap: 14px;
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  /* Side insets aligned with the section header text (16px) so the first card
     lines up with the title above it. */
  padding: 0 16px 14px;
  scroll-padding-inline: 16px;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}

.collections-carousel::-webkit-scrollbar {
  display: none;
}
</style>
