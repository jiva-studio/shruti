<script setup lang="ts">
import { computed } from "vue"
import CollectionCard from "./CollectionCard.vue"
import SectionHeader from "./SectionHeader.vue"
import type { CarouselItem } from "./CollectionsCarousel.vue"

/**
 * A titled grid of square cover tiles — the carousel's sibling for sections that
 * read better as a wrapping grid than a horizontal scroll. Columns are
 * responsive: as many `minTile`-wide tiles as fit the row (≥2 on a phone, more
 * on a wider screen), via CSS grid auto-fill.
 */
const props = withDefaults(
  defineProps<{
    title: string
    items: readonly CarouselItem[]
    /** Prefix the card names with "#" (topics). */
    hashtag?: boolean
    seeAll?: boolean
    seeAllLabel?: string
    /** Minimum tile width (px); drives how many columns fit per row. */
    minTile?: number
  }>(),
  { minTile: 150 }
)

const emit = defineEmits<{ select: [id: string]; more: [] }>()

const gridStyle = computed(() => ({
  gridTemplateColumns: `repeat(auto-fill, minmax(${props.minTile}px, 1fr))`,
}))
</script>

<template>
  <div class="tile-section">
    <SectionHeader
      :title="title"
      :see-all="seeAll"
      :see-all-label="seeAllLabel"
      @more="emit('more')"
    />
    <div class="tile-grid" :style="gridStyle">
      <CollectionCard
        v-for="item in items"
        :key="item.id"
        :name="item.name"
        :cover-url="item.coverUrl"
        :hashtag="hashtag"
        @click="emit('select', item.id)"
      />
    </div>
  </div>
</template>

<style scoped>
.tile-grid {
  display: grid;
  gap: 12px;
  padding: 0 16px 14px;
  /* keep each tile its own square — don't stretch to the tallest in the row */
  align-items: start;
}

/* Tiles fill their grid cell as squares (the card is fixed-size for carousels). */
.tile-grid :deep(.collection-card) {
  width: 100%;
  height: auto;
  aspect-ratio: 1 / 1;
}
</style>
