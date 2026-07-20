<template>
  <div v-if="!library.isEmpty" class="my-library-shelf">
    <SectionHeader
      :title="$t('library.myLibrary.title')"
      see-all
      :see-all-label="$t('library.myLibrary.seeAll')"
      @more="openAll"
    />
    <div class="shelf-scroll">
      <div v-for="item in preview" :key="item.id" class="shelf-cell">
        <LibraryItemCard :item="item" @select="onSelect" @retry="onRetry" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue"
import { useRouter } from "vue-router"
import { SectionHeader } from "@ui/features/collections/index.js"
import { useLibraryStore } from "@lectorium/stores/useLibraryStore.js"
import { useTrackActionSheet } from "@lectorium/composables/useTrackActionSheet.js"
import { useLectorium } from "@lectorium/lectorium.js"
import type { LibraryItem } from "@lib/domain/libraryItem.js"
import type { TrackId } from "@lib/domain/core.js"
import LibraryItemCard from "./LibraryItemCard.vue"

/**
 * "My library" shelf on the Search landing — a horizontally-scrolling preview
 * of the user's personal-library items (epic #1236) with a "see all" chevron
 * into `MyLibraryView`. Renders nothing when the personal library is empty, so
 * the landing is unchanged for users who never added a lecture. Self-contained:
 * owns its store read so `SearchView` only drops the tag in.
 */
const SHELF_PREVIEW = 10

const library = useLibraryStore()
const trackActions = useTrackActionSheet()
const router = useRouter()
const app = useLectorium()

void library.ensureLoaded()

const preview = computed(() => library.items.slice(0, SHELF_PREVIEW))

function openAll(): void {
  void app.haptics.impact("light")
  void router.push({ name: "my-library" })
}

function onSelect(item: LibraryItem): void {
  if (!item.trackId) return
  void app.haptics.impact("light")
  void trackActions.present(item.trackId as TrackId)
}

function onRetry(): void {
  void library.retry()
}
</script>

<style scoped>
.my-library-shelf {
  margin-bottom: 4px;
}

/* Horizontal scroller aligned to the shared 16px list gutter. */
.shelf-scroll {
  display: flex;
  gap: 12px;
  overflow-x: auto;
  padding: 0 16px 4px;
  scroll-snap-type: x proximity;
  -webkit-overflow-scrolling: touch;
}

.shelf-scroll::-webkit-scrollbar {
  display: none;
}

.shelf-cell {
  flex: 0 0 auto;
  width: 132px;
  scroll-snap-align: start;
}
</style>
