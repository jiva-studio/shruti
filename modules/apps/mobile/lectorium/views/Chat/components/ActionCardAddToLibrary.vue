<template>
  <div v-if="payload" class="add-card">
    <TrackTile
      :title="payload.title"
      :subtitle="payload.author ?? ''"
      :cover="payload.thumbnail"
      :status="status"
      :progress="liveStatus?.kind === 'pending' ? liveStatus : undefined"
      :can-retry="true"
      :add-label="$t('chat.actionAddToLibraryConfirm')"
      :selectable="selectable ?? false"
      @add="emit('confirm', actionId)"
      @retry="emit('confirm', actionId)"
      @select="emit('open')"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue"
import TrackTile, { type TileStatus } from "@lectorium/components/TrackTile.vue"
import type { ChatActionPayload } from "@lib/domain/chatMessage.js"
import type { ActionState } from "@lectorium/stores/useChatStore.js"

/**
 * A track the chat found elsewhere, offered as a candidate (personal library,
 * epic #1236). Confirming it PRO-gates and starts the fetch.
 *
 * The tile is `TrackTile`, the one the personal library is made of and the one
 * the search results use — a track found by asking, a track found by searching
 * and a track already added are the same object at different points, so they
 * are one component and the corner says which point it is at.
 *
 * This is the adapter: it turns the chat's own vocabulary — the action
 * lifecycle, the polled ingest status, "already in library" — into the four
 * states the tile knows. The store still owns every side effect.
 *
 * A track already in the library opens on the track sheet, like its tile does
 * everywhere else — but only when the parent says there is a lecture behind it
 * (`selectable`), so an unresolvable tile stays a picture (#1788).
 */
const props = defineProps<{
  actionId: string
  payload?: Extract<ChatActionPayload, { kind: "add_to_library" }>
  state: ActionState
  /** The user already has this track — show it as in-library, not addable. */
  alreadyInLibrary?: boolean
  /** Live ingest status of the matching library item (from the status poll),
   *  driving the inline progress badge / retry. Undefined once ready or unadded. */
  liveStatus?: { kind: "pending" | "failed"; label: string; percent?: number }
  /** Whether the added track resolves to something openable — the surface that
   *  owns the library store decides, and a tile only claims to be a button when
   *  it does. */
  selectable?: boolean
}>()

const emit = defineEmits<{
  (e: "confirm", actionId: string): void
  (e: "open"): void
}>()

// The live ingest status outranks the action lifecycle: the action is "done"
// the moment the submit returns, while the track itself is still being fetched,
// and the badge is the truer answer to "what is happening".
const status = computed<TileStatus>(() => {
  if (props.liveStatus?.kind === "pending") return "pending"
  if (props.liveStatus?.kind === "failed" || props.state === "error") return "failed"
  if (props.state === "pending" && !props.alreadyInLibrary) return "addable"
  return "ready"
})
</script>

<style scoped>
/* The tile sits in the message flow, so the spacing is the bubble's business.
   Half width: a candidate is an offer inside a sentence, not a shelf. */
.add-card {
  width: 60%;
  max-width: 220px;
  margin: 10px 0;
}
</style>
