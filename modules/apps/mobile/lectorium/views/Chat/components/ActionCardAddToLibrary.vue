<template>
  <AddableLectureCard
    v-if="payload"
    class="add-card"
    :title="payload.title"
    :subtitle="payload.author ?? ''"
    :cover="payload.thumbnail"
    :state="cardState"
    :progress="liveStatus?.kind === 'pending' ? liveStatus : undefined"
    :add-label="$t('chat.actionAddToLibraryConfirm')"
    :retry-label="$t('chat.actionRetry')"
    :done-label="alreadyInLibrary ? $t('search.actions.alreadyInLibrary') : ''"
    @add="emit('confirm', actionId)"
  />
</template>

<script setup lang="ts">
import { computed } from "vue"
import AddableLectureCard, { type AddableState } from "@lectorium/components/AddableLectureCard.vue"
import type { ChatActionPayload } from "@lib/domain/chatMessage.js"
import type { ActionState } from "@lectorium/stores/useChatStore.js"

/**
 * Candidate card for an external lecture the chat found (personal library,
 * epic #1236). Tapping it runs the `add_to_library` action, which PRO-gates and
 * triggers ingest of the external lecture.
 *
 * The picture is `AddableLectureCard`, shared with the search results, so a
 * lecture found by asking and one found by searching are the same object. This
 * is the adapter: it turns the chat's own vocabulary — the action lifecycle,
 * the polled ingest status, "already in library" — into the four states the
 * card knows. The store still owns every side effect.
 */
const props = defineProps<{
  actionId: string
  payload?: Extract<ChatActionPayload, { kind: "add_to_library" }>
  state: ActionState
  /** The user already has this lecture — show it as in-library, not addable. */
  alreadyInLibrary?: boolean
  /** Live ingest status of the matching library item (from the status poll),
   *  driving the inline progress badge / retry. Undefined once ready or unadded. */
  liveStatus?: { kind: "pending" | "failed"; label: string; percent?: number }
}>()

const emit = defineEmits<{
  (e: "confirm", actionId: string): void
}>()

// The live ingest status outranks the action lifecycle: the action is "done"
// the moment the submit returns, while the lecture itself is still being
// fetched, and the badge is the truer answer to "what is happening".
const cardState = computed<AddableState>(() => {
  if (props.liveStatus?.kind === "pending") return "pending"
  if (props.liveStatus?.kind === "failed" || props.state === "error") return "failed"
  if (props.state === "executing") return "busy"
  if (props.state === "pending" && !props.alreadyInLibrary) return "addable"
  return "ready"
})
</script>

<style scoped>
/* The card sits in the message flow, so the spacing is the bubble's business
   and not the shared shell's. */
.add-card {
  margin: 10px 0;
  border-radius: 4px;
}
</style>
