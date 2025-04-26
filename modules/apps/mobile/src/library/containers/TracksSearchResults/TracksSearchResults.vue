<template>
  <IonList>
    <TracksListItem
      v-for="item in tracks"
      :key="item.trackId"
      :track-id="item.trackId"
      :title="item.title"
      :author="item.author"
      :location="item.location"
      :references="item.references"
      :status="item.status"
      :date="item.date"
      @click="onTrackClick(item.trackId)"
    />
  </IonList>

  <IonInfiniteScroll
    :disabled="!infiniteScrollEnabled"
    @ion-infinite="onInfiniteSctoll"
  >
    <IonInfiniteScrollContent />
  </IonInfiniteScroll>
</template>

<script setup lang="ts">
import { ref, toRefs, onMounted } from 'vue'
import { IonList, IonInfiniteScroll, IonInfiniteScrollContent, InfiniteScrollCustomEvent } from '@ionic/vue'
import { watchDebounced } from '@vueuse/core'
import { useDAL, TracksListItem, TracksListItemData, useSafeOperation, useConfig } from '@/app'
import { mapTrackToPlaylistItem } from '@/home'
import { useUserAddsTrackToPlaylistScenario, useUserSearchesForTracksScenario } from '@/library'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const dal = useDAL()
const config = useConfig()
const userAddsTrackToPlaylist = useUserAddsTrackToPlaylistScenario()
const userSearchesForTracks = useUserSearchesForTracksScenario()
const safeOperation = useSafeOperation()

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

const { filters } = toRefs(props)

defineExpose({
  refresh: async () => {
    trackIdsInPlaylist.value = await loadTrackIdsInPlaylist()
    await loadTracks(0, filters.value)
  },
})


/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const tracks = ref<TracksListItemData[]>([])
const infiniteScrollEnabled = ref<boolean>(true)
const trackIdsInPlaylist = ref<string[]>([])


/* -------------------------------------------------------------------------- */
/*                                    Hooks                                   */
/* -------------------------------------------------------------------------- */

watchDebounced(filters, async (v) => {
  await loadTracks(0, v)
}, { debounce: 500, maxWait: 1000, deep: true })

onMounted(async () => {
  trackIdsInPlaylist.value = await loadTrackIdsInPlaylist()
  await loadTracks(0, filters.value)
})

dal.playlistItems.subscribe(async (e) => {
  const track = tracks.value.find(x => x.trackId === e.item.trackId)
  if (track) {
    track.status = e.event == 'added' ? 'added' : 'none'
  } else {
    console.warn('Track not found in the list:', e.item.trackId, tracks.value)
  }
})

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

async function onInfiniteSctoll(e: InfiniteScrollCustomEvent) {
  await loadTracks(tracks.value.length, filters.value)
  e.target.complete()
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
        x => mapTrackToPlaylistItem(
          x, 
          config.appLanguage.value,
          trackIdsInPlaylist.value.includes(x._id) ? 'added' : 'none',
        ))
    )
    if (offset === 0) { 
      tracks.value = items 
    } else {
      tracks.value.push(...items)
    }
    infiniteScrollEnabled.value = items.length === pageSize 
  } catch (error) {
    // TODO: better error handling
    console.error('Error fetching track suggestions:', error)
    return []
  }
}

async function loadTrackIdsInPlaylist(): Promise<string[]> {
  const playlist = await dal.playlistItems.getAll()
  return playlist.map(x => x.trackId) ?? []
}
</script>