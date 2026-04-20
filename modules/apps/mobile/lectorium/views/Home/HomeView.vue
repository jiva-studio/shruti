<template>
  <AppPage :loading="isLoading && rows.length === 0" :player-open="player.open">
    <IonText v-if="error" color="danger" class="ion-padding">
      <p>{{ error }}</p>
    </IonText>
    <PlaylistSection
      v-else
      :rows="rows"
      :up-next-title="$t('home.upNext')"
      :empty-header="$t('home.playlistIsEmpty')"
      :empty-message="$t('home.tapToAddTracks')"
      :empty-image="emptyImage"
      @click="onSelect"
      @delete="onRemove"
    />
    <IonInfiniteScroll :disabled="!hasMore" @ion-infinite="onInfinite">
      <IonInfiniteScrollContent />
    </IonInfiniteScroll>
  </AppPage>
</template>

<script setup lang="ts">
import {
  IonText,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  type InfiniteScrollCustomEvent,
} from "@ionic/vue"
import { AppPage } from "@ui/primitives/index.js"
import { PlaylistSection } from "@ui/features/playlist/index.js"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"
import { useHomeController } from "./HomeView.controller.js"

const emptyImage = "/playlist-empty.png"

const player = usePlayerStore()
const { rows, isLoading, error, hasMore, loadMore, onSelect, onRemove } = useHomeController()

async function onInfinite(e: InfiniteScrollCustomEvent): Promise<void> {
  await loadMore()
  await e.target.complete()
}
</script>
