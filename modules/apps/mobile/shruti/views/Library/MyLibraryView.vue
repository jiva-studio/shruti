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
      <IonText v-if="library.error && library.isEmpty" color="danger" class="ion-padding">
        <p>{{ $t("library.myLibrary.loadError") }}</p>
      </IonText>

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

      <div v-else class="grid">
        <LibraryItemCard
          v-for="item in library.items"
          :key="item.id"
          :item="item"
          @select="onSelect"
          @retry="onRetry"
        />
      </div>
    </IonContent>
  </IonPage>
</template>

<script setup lang="ts">
import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonPage,
  IonSpinner,
  IonText,
  IonTitle,
  IonToolbar,
  onIonViewWillEnter,
} from "@ionic/vue"
import { IconVinyl } from "@tabler/icons-vue"
import { FlatHeader } from "@ui/primitives/index.js"
import { useLibraryStore } from "@shruti/stores/useLibraryStore.js"
import { useOpenLibraryItem } from "@shruti/composables/useOpenLibraryItem.js"
import { useRetryLibraryItem } from "@shruti/composables/useRetryLibraryItem.js"
import { useIngestStatusPolling } from "@shruti/composables/useIngestStatusPolling.js"
import LibraryItemCard from "./components/LibraryItemCard.vue"

/**
 * The full "My library" list — every personal-library item the user added
 * (epic #1236), newest-first, as cover cards with an ingest-status badge.
 * Read-only: the rows are pulled from the server-owned `library_items`
 * collection; the sync poller flips `processing → ready` in place.
 */
const library = useLibraryStore()
const onSelect = useOpenLibraryItem()
const onRetry = useRetryLibraryItem()

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
