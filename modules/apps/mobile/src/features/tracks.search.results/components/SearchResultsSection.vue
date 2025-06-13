<template>
  <TrackListItem
    v-for="item in searchResultsStore.items"
    :key="item.trackId"
    :track-id="item.trackId"
    :date="item.date"
    :title="item.title"
    :author="item.author"
    :location="item.location"
    :references="item.references"
    :tags="item.tags"
    @click="emit('click', item.trackId)"
  >
    <template #state="{ trackId }">
      <slot
        name="state"
        :track-id="trackId"
      />
    </template>
  </TrackListItem>

  <IonInfiniteScroll
    v-if="!searchResultsStore.isLastPage"
    @ion-infinite="onInfiniteSctoll"
  >
    <IonInfiniteScrollContent />
  </IonInfiniteScroll>
</template>


<script setup lang="ts">
import { IonInfiniteScroll, IonInfiniteScrollContent, InfiniteScrollCustomEvent } from '@ionic/vue'
import { TrackListItem } from '@lectorium/mobile/features/tracks.view'
import { useWaiter } from '@lectorium/mobile/features/app.core'
import { useTrackSearchResultsStore } from '../composables/useTrackSearchResultsStore'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const searchResultsStore = useTrackSearchResultsStore()
const waiter = useWaiter()

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const emit = defineEmits<{
  click: [trackId: string]
}>()

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onInfiniteSctoll(e: InfiniteScrollCustomEvent) {
  searchResultsStore.loadNextPage()
  waiter.waitToBeTruthy(
    () => searchResultsStore.isLoading === false
  ).then(
    () => { e.target.complete() }
  )
}
</script>
