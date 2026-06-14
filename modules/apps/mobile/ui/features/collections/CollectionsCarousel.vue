<template>
  <div v-if="items.length" class="collections-carousel">
    <CollectionCard
      v-for="c in items"
      :key="c.id"
      :name="c.name"
      :cover-url="c.coverUrl"
      :author-image-urls="c.authorImageUrls"
      @click="emit('select', c.id)"
    />
  </div>
</template>

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
  /** Author avatars, shown as overlapping circles on the card. */
  readonly authorImageUrls?: readonly string[]
}

defineProps<{ items: readonly CarouselItem[] }>()
const emit = defineEmits<{ (e: "select", id: string): void }>()
</script>

<style scoped>
.collections-carousel {
  display: flex;
  gap: 14px;
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  /* Side insets so the first/last cards aren't flush to the screen edges. */
  padding: 6px 20px 14px;
  scroll-padding-inline: 20px;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}

.collections-carousel::-webkit-scrollbar {
  display: none;
}
</style>
