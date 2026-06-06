<template>
  <template v-if="rows.length > 0">
    <slot name="header" />
    <PlaylistItems :rows="rows" @click="emit('click', $event)" @delete="emit('delete', $event)" />
  </template>
  <PageSticker
    v-else
    :image="emptyImage"
    :header="emptyHeader"
    :message="emptyMessage"
    to="search"
    @navigate="onNavigate"
  >
    <template #footer>
      <slot name="empty-footer" />
    </template>
  </PageSticker>
</template>

<script setup lang="ts">
import { useRouter } from "vue-router"
import { PageSticker } from "@ui/primitives/index.js"
import type { UiTrackRow } from "@ui/components/tracks/list/index.js"
import PlaylistItems from "./PlaylistItems.vue"

const router = useRouter()

// PageSticker is router-agnostic (kit) — it emits `navigate` with its `to`
// payload and we route here, preserving the previous `router.replace` behaviour.
function onNavigate(to: string | undefined): void {
  if (to) router.replace({ name: to })
}

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
