<template>
  <!-- Items present: header + horizontal preview of cover cards. -->
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
  <!-- Empty: the SAME entry banner the Smart Library / whole-library rows use,
       rendered as a direct sibling (NOT inside a wrapper) so it inherits the
       banner's own gutter margins and lines up exactly with its neighbours. -->
  <LibraryBanner
    v-else
    :title="$t('library.myLibrary.title')"
    :description="$t('library.myLibrary.emptyMessage')"
    background="/library/search-bg.webp"
    background-dark="/library/search-bg-dark.webp"
    @click="openAll"
  />
</template>

<script setup lang="ts">
import { computed } from "vue"
import { useRouter } from "vue-router"
import { SectionHeader, LibraryBanner } from "@ui/features/collections/index.js"
import { useLibraryStore } from "@lectorium/stores/useLibraryStore.js"
import { useOpenLibraryItem } from "@lectorium/composables/useOpenLibraryItem.js"
import { useRetryLibraryItem } from "@lectorium/composables/useRetryLibraryItem.js"
import { useLectorium } from "@lectorium/lectorium.js"
import LibraryItemCard from "./LibraryItemCard.vue"

/**
 * "My library" shelf on the Search landing — a horizontally-scrolling preview
 * of the user's personal-library items (epic #1236) with a "see all" chevron
 * into `MyLibraryView`. When empty it collapses to a single `LibraryBanner`
 * (the same entry-banner the Smart Library / whole-library rows use) so the
 * personal library is always reachable AND visually consistent with its
 * neighbours. Self-contained: owns its store read so `SearchView` only drops
 * the tag in.
 */
const SHELF_PREVIEW = 10

const library = useLibraryStore()
const onSelect = useOpenLibraryItem()
const onRetry = useRetryLibraryItem()
const router = useRouter()
const app = useLectorium()

void library.ensureLoaded()

const preview = computed(() => library.items.slice(0, SHELF_PREVIEW))

function openAll(): void {
  void app.haptics.impact("light")
  void router.push({ name: "my-library" })
}
</script>

<style scoped>
.my-library-shelf {
  margin-bottom: 4px;
}

/* Same horizontal carousel as the collections shelves (CollectionsCarousel):
 * 16px side insets + scroll-padding so the first/last card get an edge gutter
 * without shifting the container, and the scrollbar is hidden (it's a phone). */
.shelf-scroll {
  display: flex;
  gap: 14px;
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  padding: 0 16px 14px;
  scroll-padding-inline: 16px;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
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
