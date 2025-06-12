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
        :disabled="trackStateStore.getState(item.trackId).isFailed"
        @click="emit('click', item.playlistItemId)"
      >
        <template #state="{ trackId }">
          <TrackStateIndicator 
            :track-id="trackId"
            :ignore-states="['added']"
          />
        </template>
      </TrackListItem>
    </WithDeleteAction>
  </template>
</template>


<script setup lang="ts">
import { WithDeleteAction } from '@lectorium/mobile/features/app.core'
import { TrackListItem } from '@lectorium/mobile/features/tracks.view'
import { TrackStateIndicator, useTrackStateStore } from '@lectorium/mobile/features/tracks.state'
import { usePlaylistStore } from '../composables/usePlaylistStore'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const playlistStore = usePlaylistStore()
const trackStateStore = useTrackStateStore()

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const emit = defineEmits<{
  click: [playlistItemId: string]
  delete: [playlistItemId: string]
}>()
</script>