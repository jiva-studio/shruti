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
    />
  </IonList>
</template>


<script setup lang="ts">
import { useAsyncState } from '@vueuse/core'
import { IonList } from '@ionic/vue'
import { mapTrackToPlaylistItem, SectionHeader, useUserSeesSuggestionsScenario } from '@/home'
import { TracksListItem, type TracksListItemData, useConfig } from '@/app'
import { useDAL } from '@/app'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const dal = useDAL()
const config = useConfig()
const userSeesSuggestions = useUserSeesSuggestionsScenario()

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