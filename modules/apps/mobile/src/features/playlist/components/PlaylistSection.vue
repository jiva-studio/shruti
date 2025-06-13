<template>
  <SectionHeader :title="$t('home.upNext')" />
  <PlaylistItems
    v-if="!playlistStore.isEmpty()"
    @click="emit('click', $event)"
    @delete="emit('delete', $event)"
  />
  <PlaylistEmpty
    v-else
    navigation-path="search"
  />
</template>

<script setup lang="ts">
import { SectionHeader } from '@lectorium/mobile/features/app.core'
import { usePlaylistStore } from '../composables/usePlaylistStore'
import PlaylistItems from './PlaylistItems.vue'
import PlaylistEmpty from './PlaylistEmpty.vue'

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