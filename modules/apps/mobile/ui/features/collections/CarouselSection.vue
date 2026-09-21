<script setup lang="ts">
import CollectionsCarousel, { type CarouselItem } from "./CollectionsCarousel.vue"
import SectionHeader from "./SectionHeader.vue"

/**
 * A titled cover carousel: a section header (with an optional "see all" chevron)
 * over a CollectionsCarousel. One component for every carousel shelf on Search —
 * collection groups and the topics row — so the header/gap stay identical.
 */
defineProps<{
  title: string
  items: readonly CarouselItem[]
  /** Prefix the card names with "#" (topics). */
  hashtag?: boolean
  /** Show the "see all" chevron. */
  seeAll?: boolean
  seeAllLabel?: string
}>()

const emit = defineEmits<{ select: [id: string]; more: [] }>()
</script>

<template>
  <div class="carousel-section">
    <SectionHeader
      :title="title"
      :see-all="seeAll"
      :see-all-label="seeAllLabel"
      @more="emit('more')"
    />
    <CollectionsCarousel :items="items" :hashtag="hashtag" @select="emit('select', $event)" />
  </div>
</template>
