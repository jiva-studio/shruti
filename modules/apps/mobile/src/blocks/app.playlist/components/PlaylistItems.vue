<template>
  <template
    v-for="item in playlistStore.items"
    :key="item.playlistItemId"
  >
    <WithDeleteAction 
      @delete="emit('delete', item.playlistItemId)" 
    >
      <TrackListItem
        :track-id="item.trackId"
        :title="item.title"
        :author="item.author"
        :location="item.location"
        :references="item.references"
        :tags="item.tags"
        :date="item.date"
        @click="emit('click', item.playlistItemId)"
      >
        <template #state="{ trackId }">
          <PlaylistStateIndicator :track-id="trackId" />
        </template>
      </TrackListItem>
    </WithDeleteAction>
  </template>
</template>


<script setup lang="ts">
import { WithDeleteAction } from '@blocks/app.core'
import { TrackListItem } from '@blocks/app.tracks.view'
import { usePlaylistStore } from '../composables/usePlaylistStore'
import PlaylistStateIndicator from './PlaylistStateIndicator.vue'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const playlistStore = usePlaylistStore()

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const emit = defineEmits<{
  click: [playlistItemId: string]
  delete: [playlistItemId: string]
}>()
</script>