<template>
  <SectionHeader title="You Might Like" />
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
import { mapTrackToPlaylistItem, SectionHeader } from '@/home'
import { TracksListItem, type TracksListItemData } from '@/app'
import { useDAL } from '@/app'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const dal = useDAL()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const { state } = useAsyncState(
  getSuggestions(),
  [],
  { immediate: true, resetOnExecute: false }
)

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

async function getSuggestions() : Promise<TracksListItemData[]> {
  try {
    const suggestedTracks = await dal.tracks.getAll()
    return await Promise.all(suggestedTracks.map(mapTrackToPlaylistItem))
  } catch (error) {
    // TODO: better error handling
    console.error('Error fetching track suggestions:', error)
    return []
  }
}
</script>