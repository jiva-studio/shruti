<template>
  <div class="my-library-shelf">
    <SectionHeader
      :title="$t('library.myLibrary.title')"
      see-all
      :see-all-label="$t('library.myLibrary.seeAll')"
      @more="openAll"
    />
    <div v-if="!library.isEmpty" class="shelf-scroll">
      <div v-for="item in preview" :key="item.id" class="shelf-cell">
        <LibraryItemCard :item="item" @select="onSelect" @retry="onRetry" />
      </div>
    </div>
    <button v-else type="button" class="shelf-empty" @click="openAll">
      {{ $t('library.myLibrary.emptyMessage') }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue"
import { useRouter } from "vue-router"
import { SectionHeader } from "@ui/features/collections/index.js"
import { useLibraryStore } from "@shruti/stores/useLibraryStore.js"
import { useTrackActionSheet } from "@shruti/composables/useTrackActionSheet.js"
import { useShruti } from "@shruti/shruti.js"
import type { LibraryItem } from "@lib/domain/libraryItem.js"
import type { TrackId } from "@lib/domain/core.js"
import LibraryItemCard from "./LibraryItemCard.vue"

/**
 * "My library" shelf on the Search landing — a horizontally-scrolling preview
 * of the user's personal-library items (epic #1236) with a "see all" chevron
 * into `MyLibraryView`. The header is ALWAYS shown so the personal library is
 * reachable even when empty (tapping through lands on MyLibraryView's empty
 * state); the card strip is replaced by a one-line prompt when there are no
 * items yet. Self-contained: owns its store read so `SearchView` only drops the
 * tag in.
 */
const SHELF_PREVIEW = 10

const library = useLibraryStore()
const trackActions = useTrackActionSheet()
const router = useRouter()
const app = useShruti()

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

/* Empty state: a tappable one-line prompt that keeps the entry reachable,
   aligned to the shared 16px list gutter. */
.shelf-empty {
  display: block;
  width: calc(100% - 32px);
  margin: 0 16px 4px;
  padding: 0;
  text-align: left;
  background: none;
  border: none;
  color: var(--ion-color-medium, #92949c);
  font-size: 13px;
  line-height: 1.4;
  cursor: pointer;
}
</style>
