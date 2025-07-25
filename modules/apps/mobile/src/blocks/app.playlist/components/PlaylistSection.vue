<template>
  <SectionHeader 
    v-if="!playlistStore.isEmpty"
    :title="$t('home.upNext')"
  />
  <PlaylistItems
    v-if="!playlistStore.isEmpty"
    @click="emit('click', $event)"
    @delete="emit('delete', $event)"
  />
  <PageSticker
    v-else
    :header="$t('home.playlistIsEmpty')"
    :message="$t('home.tapToAddTracks')"
    :image="playlistIsEmptyImg"
    navigation-path="search"
  />
</template>

<script setup lang="ts">
import { SectionHeader } from '@blocks/app.core'
import { PageSticker } from '@blocks/app.ui.kit'
import { usePlaylistStore } from '../composables/usePlaylistStore'
import PlaylistItems from './PlaylistItems.vue'
import playlistIsEmptyImg from '../assets/empty.png'

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