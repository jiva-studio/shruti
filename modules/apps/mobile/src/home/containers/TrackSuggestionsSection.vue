<template>
  <SectionHeader :title="$t('home.youMightLike')" />
  <IonList lines="none">
    <TracksListItem 
      v-for="item in state"
      :key="item.trackId"
      :track-id="item.trackId"
      :title="item.title"
      :author="item.author"
      :location="item.location"
      :references="item.references"
      :date="item.date"
      :status="item.status"
      @click="onTrackClick(item.trackId)"
    />
  </IonList>
</template>


<script setup lang="ts">
import { useAsyncState } from '@vueuse/core'
import { IonList } from '@ionic/vue'
import { SectionHeader, useUserSeesSuggestionsScenario } from '@lectorium/mobile/home'
import { TracksListItem, type TracksListItemData, useConfig } from '@lectorium/mobile/app'
import { mapTrackToPlaylistItem } from '@lectorium/mobile/home/mappers/tracks'
import { useUserAddsTrackToPlaylistScenario } from '@lectorium/mobile/library'
import { useSafeOperation } from '@lectorium/mobile/app'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const config = useConfig()
const userSeesSuggestions = useUserSeesSuggestionsScenario()
const userAddsTrackToPlaylist = useUserAddsTrackToPlaylistScenario()
const safeOperation = useSafeOperation()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const { state, execute: refresh } = useAsyncState(
  async () => await getSuggestions(),
  [], { immediate: true, resetOnExecute: false }
)

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

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
  try {
    const suggestedTracks = await userSeesSuggestions.execute()
    return await Promise.all(
      suggestedTracks.map(x => mapTrackToPlaylistItem(x, config.appLanguage.value))
    )
  } catch (error) {
    // TODO: better error handling
    console.error('Error fetching track suggestions:', error)
    return []
  }
}
</script>