<template>
  <IonPage>
    <FlatHeader>
      <IonToolbar>
        <IonButtons slot="start">
          <IonBackButton default-href="/tabs/search" />
        </IonButtons>
        <IonTitle>{{ $t("library.myLibrary.title") }}</IonTitle>
      </IonToolbar>
    </FlatHeader>

    <IonContent :fullscreen="true">
      <!-- The read failed. The instruction has to be one the app can honour:
           there is no refresher to pull, so the retry is this button. -->
      <div v-if="library.error && library.isEmpty" class="load-error">
        <IonText color="danger">
          <p>{{ $t("library.myLibrary.loadError") }}</p>
        </IonText>
        <IonButton fill="outline" size="small" :disabled="library.isLoading" @click="onReload">
          {{ $t("library.status.retry") }}
        </IonButton>
      </div>

      <div v-else-if="library.isEmpty && library.isLoading" class="loading">
        <IonSpinner name="dots" />
      </div>

      <div v-else-if="library.isEmpty && !library.isLoading" class="empty">
        <div class="empty-badge">
          <IconVinyl :size="34" />
        </div>
        <b class="empty-title">{{ $t("library.myLibrary.emptyTitle") }}</b>
        <span class="empty-message">{{ $t("library.myLibrary.emptyMessage") }}</span>
      </div>

      <div v-else-if="shown.length" class="grid">
        <LibraryItemCard
          v-for="item in shown"
          :key="item.id"
          :item="item"
          @select="onSelect"
          @retry="onRetry"
        />
      </div>

      <!-- Narrowed to nothing: the library is not empty, this query is. -->
      <div v-else class="empty">
        <b class="empty-title">{{ $t("search.noResultsTitle") }}</b>
        <span class="empty-message">{{ $t("search.library.empty") }}</span>
      </div>

      <DockSpacer />
    </IonContent>
  </IonPage>
</template>

<script setup lang="ts">
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonPage,
  IonSpinner,
  IonText,
  IonTitle,
  IonToolbar,
  onIonViewWillEnter,
} from "@ionic/vue"
import { computed } from "vue"
import { IconVinyl } from "@tabler/icons-vue"
import { FlatHeader } from "@ui/primitives/index.js"
import { useLibraryStore } from "@lectorium/stores/useLibraryStore.js"
import { useSearchDock } from "@lectorium/composables/useSearchDock.js"
import DockSpacer from "@lectorium/components/DockSpacer.vue"
import { useOpenLibraryItem } from "@lectorium/composables/useOpenLibraryItem.js"
import { useRetryLibraryItem } from "@lectorium/composables/useRetryLibraryItem.js"
import { useIngestStatusPolling } from "@lectorium/composables/useIngestStatusPolling.js"
import LibraryItemCard from "./components/LibraryItemCard.vue"

/**
 * The full "My library" list — every personal-library item the user added
 * (epic #1236), newest-first, as cover cards with an ingest-status badge.
 * Read-only: the rows are pulled from the server-owned `library_items`
 * collection; the sync poller flips `processing → ready` in place.
 *
 * The search field narrows it to what matches — where the search page's
 * personal-library shelf leads. A second page for "the same list, but from a
 * search" would be this one with a filter, and then two of them to keep in
 * step.
 *
 * That field is docked at the root and floats over this page, so the query is
 * read live from the shared ref; `?q=` only seeds it on a cold arrival.
 */
const props = withDefaults(defineProps<{ initialQuery?: string }>(), { initialQuery: "" })

const library = useLibraryStore()
const onSelect = useOpenLibraryItem()
const onRetry = useRetryLibraryItem()

const { text: query } = useSearchDock()
if (props.initialQuery && !query.value.trim()) query.value = props.initialQuery

const shown = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase()
  if (!needle) return library.items
  return library.items.filter((i) => (i.titleRaw ?? "").toLocaleLowerCase().includes(needle))
})

function onReload(): void {
  void library.refresh()
}

useIngestStatusPolling()

void library.ensureLoaded()

onIonViewWillEnter(() => {
  void library.ensureLoaded()
})
</script>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 16px 12px;
  padding: 16px;
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 60vh;
  padding: 24px;
  text-align: center;
}

.load-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 16px;
  text-align: center;
}

.loading {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 60vh;
}

.empty-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 72px;
  height: 72px;
  border-radius: 50%;
  background: var(--ion-color-light, #f4f5f8);
  color: var(--ion-color-medium, #92949c);
  margin-bottom: 4px;
}

.empty-title {
  font-size: 16px;
}

.empty-message {
  font-size: 14px;
  color: var(--ion-color-medium, #92949c);
  max-width: 280px;
}
</style>
