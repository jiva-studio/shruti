<template>
  <SectionHeader title="You Might Like" />
  <IonList lines="none">
    <PlaylistItem 
      v-for="item in state"
      :key="item.trackId"
      :trackId="item.trackId"
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
import { IonList } from '@ionic/vue';
import { mapTrackToPlaylistItem, PlaylistItem, SectionHeader, type PlaylistItemData } from '@/home';
import { useDAL } from '@/app';

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

async function getSuggestions() : Promise<PlaylistItemData[]> {
  try {
    const suggestedTracks = await dal.tracks.getAll()
    return await Promise.all(suggestedTracks.map(mapTrackToPlaylistItem))
  } catch (error) {
    console.error("Error fetching track suggestions:", error)
    return []
  }
}
</script>