<template>
  <SectionHeader :title="title" />
  <IonList lines="none">
    <TracksListItem 
      v-for="item in state"
      :key="item.trackId"
      :track-id="item.trackId"
      :title="item.title"
      :location="item.location"
      :references="item.references"
      :tags="item.tags"
      :date="item.date"
      :icon="trackStateStore.isInPlaylist(item.trackId) ? 'added' : 'none'"
      :progress="trackStateStore.downloadProgress(item.trackId)"
      @click="onTrackClick(item.trackId)"
    />
  </IonList>
</template>


<script setup lang="ts">
import { useAsyncState } from '@vueuse/core'
import { IonList } from '@ionic/vue'
import { SectionHeader } from '@lectorium/mobile/home'
import { TracksListItem, type TracksListItemData, useConfig } from '@lectorium/mobile/app'
import { mapTrackToPlaylistItem } from '@lectorium/mobile/home/mappers/tracks'
import { useUserAddsTrackToPlaylistScenario } from '@lectorium/mobile/search'
import { useSafeOperation } from '@lectorium/mobile/app'
import { useRandomTracks } from '@lectorium/mobile/library/composables/useRandomTracks'
import { useTrackStateStore } from '@lectorium/mobile/app/stores/useTrackStateStore'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const config = useConfig()
const randomTracks = useRandomTracks()
const safeOperation = useSafeOperation()
const trackStateStore = useTrackStateStore()
const userAddsTrackToPlaylist = useUserAddsTrackToPlaylistScenario()


/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = defineProps<{
  title: string
  selector: object
  max: number
}>()

const emit = defineEmits<{
  (e: 'loading', value: boolean): void
}>()


/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const { state, execute: refresh } = useAsyncState(
  async () => await getSuggestions(),
  [], { 
    immediate: true, 
    resetOnExecute: false,
    onSuccess: () => emit('loading', false),
  }
)

defineExpose({ refresh })

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

async function onTrackClick(trackId: string) {
  safeOperation.execute({
    operation: async () => await userAddsTrackToPlaylist.execute(trackId),
  })
}

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

async function getSuggestions() : Promise<TracksListItemData[]> {
  const suggestedTracks = await randomTracks.get({ 
    max: props.max, selector: props.selector 
  })
  return await Promise.all(
    suggestedTracks.map(x => mapTrackToPlaylistItem(x, config.appLanguage.value))
  )
}
</script>