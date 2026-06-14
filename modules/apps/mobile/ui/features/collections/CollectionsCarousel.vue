<template>
  <div v-if="items.length" class="collections-carousel">
    <CollectionCard
      v-for="c in items"
      :key="c.id"
      :name="c.name"
      :cover-url="c.coverUrl"
      @click="emit('select', c.id)"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue"
import { useShruti } from "@shruti/shruti.js"
import { buildServerUrl } from "@lib/domain/servers.js"
import { getRegions } from "@shruti/services/regionsRegistry.js"
import CollectionCard from "./CollectionCard.vue"

/**
 * Horizontal swipeable carousel of featured collections on the Search page.
 * Loads the featured set for `locale`, resolves each cover key to a CDN URL,
 * and emits `select(id)` on tap so the host opens the detail surface. Renders
 * nothing when there are no featured collections (or the schema is absent),
 * so the Search page is unchanged in that case.
 */
interface CarouselItem {
  readonly id: string
  readonly name: string
  readonly coverUrl?: string
}

const props = defineProps<{ locale: string }>()
const emit = defineEmits<{ (e: "select", id: string): void }>()

const app = useShruti()
const items = ref<readonly CarouselItem[]>([])

function coverUrl(cover: string): string | undefined {
  if (!cover) return undefined
  const region = getRegions()[0]
  return region ? buildServerUrl(region, cover) : undefined
}

async function load(locale: string): Promise<void> {
  try {
    const headers = await app.repositories().collections.listFeaturedCollections(locale)
    items.value = headers.map((h) => ({ id: h.id, name: h.name, coverUrl: coverUrl(h.cover) }))
  } catch (err) {
    console.warn("[collections-carousel] load failed", err)
    items.value = []
  }
}

watch(
  () => props.locale,
  (l) => {
    void load(l)
  },
  { immediate: true }
)
</script>

<style scoped>
.collections-carousel {
  display: flex;
  gap: 14px;
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  /* Side insets so the first/last cards aren't flush to the screen edges.
     scroll-padding keeps snap alignment honouring the same gutter. */
  padding: 6px 20px 14px;
  scroll-padding-inline: 20px;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}

.collections-carousel::-webkit-scrollbar {
  display: none;
}
</style>
