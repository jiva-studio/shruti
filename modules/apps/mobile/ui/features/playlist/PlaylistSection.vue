<script setup lang="ts">
import { useRouter } from "vue-router"
import { PageSticker } from "@ui/primitives/index.js"
import PlaylistItems from "./PlaylistItems.vue"
import type { PlaylistRenderItem, UiPlaybackProgress } from "./types.js"

defineProps<{
  items: readonly PlaylistRenderItem[]
  emptyHeader: string
  emptyMessage: string
  emptyImage: string
  /** Live playback of the currently open track — forwarded to the rows, which
   *  are built without a playback position (issue #1504). */
  playback?: UiPlaybackProgress
}>()

const emit = defineEmits<{
  click: [trackId: string]
  delete: [trackId: string]
}>()

const router = useRouter()

// PageSticker is router-agnostic (kit) — it emits `navigate` with its `to`
// payload and we route here, preserving the previous `router.replace` behaviour.
function onNavigate(to: string | undefined): void {
  if (to) void router.replace({ name: to })
}
</script>

<template>
  <template v-if="items.length > 0">
    <slot name="header" />
    <PlaylistItems
      :items="items"
      :playback="playback"
      @click="emit('click', $event)"
      @delete="emit('delete', $event)"
    />
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
