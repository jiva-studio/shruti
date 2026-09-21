<script setup lang="ts">
import ActionCardShell from "./ActionCardShell.vue"
import TrackMiniRow from "./TrackMiniRow.vue"
import type { ChatActionPayload } from "@lib/domain/chatMessage.js"
import type { ActionState } from "@lectorium/stores/useChatStore.js"

defineProps<{
  actionId: string
  payload?: Extract<ChatActionPayload, { kind: "queue_next_track" }>
  state: ActionState
}>()

const emit = defineEmits<{
  (e: "confirm", actionId: string): void
}>()
</script>

<template>
  <ActionCardShell
    :show="!!payload"
    :state="state"
    dense
    :title="$t('chat.actionQueueNextTrackTitle')"
    :confirm-label="$t('chat.actionQueueNextTrackConfirm')"
    :done-label="$t('chat.actionQueueNextTrackDone')"
    :error-label="$t('chat.actionQueueNextTrackError')"
    @confirm="emit('confirm', actionId)"
  >
    <TrackMiniRow v-if="payload" :track-id="payload.trackId" />
  </ActionCardShell>
</template>
