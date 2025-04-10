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
      status="none"
    />
  </IonList>
</template>


<script setup lang="ts">
import { useAsyncState } from '@vueuse/core'
import { IonList } from '@ionic/vue';
import { PlaylistItem, SectionHeader, type PlaylistItemData } from '@/home';
import { useDAL } from '@/app';
import { Track } from '@lectorium/dal/models';

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
  const mapToPlaylistItemData = (track: Track): PlaylistItemData => ({
    trackId: track._id,
    title: track.title["en"],
    author: track.author,
    location: track.location,
    references: track.references.map(x => x.join(" ")),
    date: track.date.join("-"),
    status: "none",
  })

  return (await dal.tracks.getAll()).map(mapToPlaylistItemData)
}
</script>