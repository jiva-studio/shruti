<template>
  <template v-if="rows.length > 0">
    <slot name="header" />
    <PlaylistItems :rows="rows" @click="emit('click', $event)" @delete="emit('delete', $event)" />
  </template>
  <PageSticker
    v-else
    :header="emptyHeader"
    :message="emptyMessage"
    :image="emptyImage"
    to="search"
  />
</template>

<script setup lang="ts">
import { PageSticker } from "@ui/primitives/index.js"
import type { UiTrackRow } from "@ui/components/tracks/list/index.js"
import PlaylistItems from "./PlaylistItems.vue"

defineProps<{
  rows: readonly UiTrackRow[]
  emptyHeader: string
  emptyMessage: string
  emptyImage: string
}>()

const emit = defineEmits<{
  click: [trackId: string]
  delete: [trackId: string]
}>()
</script>
