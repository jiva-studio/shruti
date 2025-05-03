<template>
  <IonList lines="none">
    <TracksListItem
      v-for="item in tracks"
      :key="item.trackId"
      :track-id="item.trackId"
      :date="item.date"
      :title="item.title"
      :author="item.author"
      :location="item.location"
      :references="item.references"
      :icon="trackStateStore.isInPlaylist(item.trackId) ? 'added' : 'none'"
      :progress="trackStateStore.downloadProgress(item.trackId)"
      @click="onTrackClick(item.trackId)"
    />
  </IonList>

  <IonItem
    v-if="!infiniteScrollEnabled && tracks.length >= maxRecords"
    lines="none"
    class="specify-criteria"
  >
    <IonNote>
      {{ $t('library.specifySearchCriteria') }}
    </IonNote>
  </IonItem>

  <IonInfiniteScroll
    v-if="infiniteScrollEnabled"
    @ion-infinite="onInfiniteSctoll"
  >
    <IonInfiniteScrollContent />
  </IonInfiniteScroll>
</template>

<script setup lang="ts">
import { ref, toRefs, onMounted, watch } from 'vue'
import { IonList, IonInfiniteScroll, IonInfiniteScrollContent, InfiniteScrollCustomEvent, IonItem, IonNote } from '@ionic/vue'
import { TracksListItem, TracksListItemData, useSafeOperation, useConfig } from '@lectorium/mobile/app'
import { useUserAddsTrackToPlaylistScenario, useUserSearchesForTracksScenario } from '@lectorium/mobile/library'
import { mapTrackToPlaylistItem } from '@lectorium/mobile/home/mappers/tracks'
import { useTrackStateStore } from '@lectorium/mobile/app/stores'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const config = useConfig()
const safeOperation = useSafeOperation()
const trackStateStore = useTrackStateStore()
const userAddsTrackToPlaylist = useUserAddsTrackToPlaylistScenario()
const userSearchesForTracks = useUserSearchesForTracksScenario()

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

type Filters = {
  query: string
  authors: string[]
  sources: string[]
  locations: string[]
  languages: string[]
  duration: { min: number; max: number }
  dates: { from: string; to: string }
}

const props = defineProps<{
  filters: Filters
}>()


defineExpose({
  refresh: async () => {
    await loadTracks(0, filters.value)
  },
})


/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const maxRecords = 75
const tracks = ref<TracksListItemData[]>([])
const infiniteScrollEnabled = ref<boolean>(true)
const { filters } = toRefs(props)

/* -------------------------------------------------------------------------- */
/*                                    Hooks                                   */
/* -------------------------------------------------------------------------- */

watch(filters, async (v) => {
  await loadTracks(0, v)
}, { deep: true })

onMounted(async () => {
  await loadTracks(0, filters.value)
})


/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onInfiniteSctoll(e: InfiniteScrollCustomEvent) {
  loadTracks(tracks.value.length, filters.value)
    .then(() => e.target.complete())
}

async function onTrackClick(trackId: string) {
  safeOperation.execute({
    operation: async () => await userAddsTrackToPlaylist.execute(trackId),
  })
}

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

async function loadTracks(
  offset: number = 0,
  filters: Filters,
  pageSize: number = 25,
) {
  try {
    const searchResult = await userSearchesForTracks
      .execute(offset, filters, pageSize)

    const items = await Promise.all(
      searchResult.map(
        x => mapTrackToPlaylistItem(x, config.appLanguage.value)
      )
    )
    if (offset === 0) { 
      tracks.value = items 
    } else {
      tracks.value.push(...items)
    }
    infiniteScrollEnabled.value = items.length === pageSize && tracks.value.length < maxRecords
  } catch (error) {
    // TODO: better error handling
    console.error('Error fetching track suggestions:', error)
  }
}
</script>


<style scoped>
.specify-criteria {
  text-align: center;
  padding: 2rem;
}
</style>