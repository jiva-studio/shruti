<template>
  <template v-if="rows.length > 0">
    <slot name="header" />
    <PlaylistItems :rows="rows" @click="emit('click', $event)" @delete="emit('delete', $event)" />
  </template>
  <div v-else class="empty-state" @click="onEmptyClick">
    <LazyImage :src="emptyImage" class="empty-image" />
    <b class="empty-header">{{ emptyHeader }}</b>
    <span class="empty-message">{{ emptyMessage }}</span>
    <!-- empty-footer renders below the sticker so callers can append
         starter-pack chips (or any other call-to-action) without
         coupling this UI-folder component to a specific domain. -->
    <div class="empty-footer" @click.stop>
      <slot name="empty-footer" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { useRouter } from "vue-router"
import { LazyImage } from "@ui/primitives/index.js"
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

// Tapping the sticker area (image/header/message) still navigates to
// search, preserving the pre-feature behavior. The chip strip stops
// propagation so chip taps don't trigger the route change.
const router = useRouter()
function onEmptyClick() {
  router.replace({ name: "search" })
}
</script>

<style scoped>
/* flex:1 + min-height:100% mirrors the ChatView empty-state recipe:
 * the column fills the IonContent's available vertical space, then
 * justify-content:center pushes children to the geometric middle of
 * the viewport (regardless of header / tab-bar padding). Without this
 * the column hugs its children at the top. */
.empty-state {
  flex: 1 1 auto;
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  padding: 24px 16px;
  text-align: center;
}

.empty-image {
  max-width: 60%;
}

.empty-header {
  font-size: 1.5rem;
  font-weight: bold;
}

.empty-message {
  color: var(--ion-color-medium);
}

.empty-footer {
  margin-top: 1rem;
  width: 100%;
}
</style>
