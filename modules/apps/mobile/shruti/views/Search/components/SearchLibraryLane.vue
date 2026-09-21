<script setup lang="ts">
import {
  IonButton,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  type InfiniteScrollCustomEvent,
} from "@ionic/vue"
import { SectionHeader } from "@ui/features/collections/index.js"
import { TracksList } from "@ui/components/tracks/list/index.js"
import { TrackStateIndicator } from "@ui/components/tracks/state/index.js"
import type { SearchControllerReturn } from "../SearchView.controller.js"

/** The lectures already on the phone. Local, so it answers instantly. */
const props = defineProps<{ search: SearchControllerReturn }>()

async function onInfinite(e: InfiniteScrollCustomEvent): Promise<void> {
  await props.search.loadMore()
  await e.target.complete()
}
</script>

<template>
  <section class="lane">
    <SectionHeader :title="$t('search.library.title')" />

    <!-- Above the list, not instead of it: a failed page keeps what loaded. -->
    <p v-if="search.error.value" class="lane-note">{{ $t("search.library.failed") }}</p>

    <div v-if="search.showEmptyState.value" class="no-results">
      <b class="no-results-title">{{ $t("search.noResultsTitle") }}</b>
      <span class="no-results-message">{{ $t("search.library.empty") }}</span>
    </div>
    <template v-else>
      <TracksList flush :rows="search.rows.value" @select="search.onSelect">
        <template #state="{ state, progressPct }">
          <TrackStateIndicator :state="state" :progress="progressPct" />
        </template>
      </TracksList>
      <IonInfiniteScroll :disabled="!search.hasMore.value" @ion-infinite="onInfinite">
        <IonInfiniteScrollContent />
      </IonInfiniteScroll>

      <!-- A failed page disarms the scroll, so retrying needs a button. -->
      <div v-if="search.canRetry.value" class="lane-retry">
        <IonButton fill="clear" size="small" @click="search.retry()">
          {{ $t("search.library.retry") }}
        </IonButton>
      </div>
    </template>
  </section>
</template>

<style scoped>
.lane {
  margin-bottom: 4px;
}

.lane-note {
  margin: 0 16px 8px;
  color: var(--ion-color-medium);
  font-size: 13px;
  line-height: 1.35;
}

.no-results {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 24px 16px;
  text-align: center;
}

.no-results-title {
  font-size: 1rem;
  font-weight: 600;
}

.no-results-message {
  max-width: 320px;
  color: var(--ion-color-medium);
  font-size: 14px;
}

.lane-retry {
  display: flex;
  justify-content: center;
  padding: 4px 16px 8px;
}
</style>
