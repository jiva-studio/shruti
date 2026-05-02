<template>
  <SectionHeader v-if="rows.length > 0" :title="upNextTitle" />
  <PlaylistItems
    v-if="rows.length > 0"
    :rows="rows"
    @click="emit('click', $event)"
    @delete="emit('delete', $event)"
  />
  <PageSticker
    v-else
    :header="emptyHeader"
    :message="emptyMessage"
    :image="emptyImage"
    navigation-path="search"
  />
</template>

<script setup lang="ts">
import { PageSticker, SectionHeader } from "@ui/primitives/index.js"
import type { UiTrackRow } from "@ui/components/tracks/list/index.js"
import PlaylistItems from "./PlaylistItems.vue"

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

defineProps<{
  rows: readonly UiTrackRow[]
  upNextTitle: string
  emptyHeader: string
  emptyMessage: string
  emptyImage: string
}>()

const emit = defineEmits<{
  click: [trackId: string]
  delete: [trackId: string]
}>()
</script>
