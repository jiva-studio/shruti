<script setup lang="ts">
import { ref, watch } from "vue"
import ActionCardShell from "./ActionCardShell.vue"
import type { ChatActionPayload } from "@lib/domain/chatMessage.js"
import type { ActionState } from "@lectorium/stores/useChatStore.js"

const props = defineProps<{
  actionId: string
  payload?: Extract<ChatActionPayload, { kind: "enable_daily_reminder" }>
  state: ActionState
}>()

const emit = defineEmits<{
  // Second arg overrides fields the action originally carried — for
  // this card the user can change `time` before confirming. The store
  // reads it via `executeAction(messageId, actionId, { time })`.
  (e: "confirm", actionId: string, override?: { time?: string }): void
}>()

// `||`, not `??`: the wire type is a plain string, so a server that has no
// time to offer sends "" — and a blank picker would confirm a blank time.
// The watcher below already reads "" as absent.
const chosenTime = ref<string>(props.payload?.time || "07:00")
// Keep the picker in sync if the underlying payload changes (e.g.
// the card was re-rendered with a fresh tool-issued payload).
watch(
  () => props.payload?.time,
  (next) => {
    if (next && next !== chosenTime.value) chosenTime.value = next
  }
)

function onConfirm() {
  emit("confirm", props.actionId, { time: chosenTime.value })
}
</script>

<template>
  <ActionCardShell
    :show="!!payload"
    :state="state"
    :title="$t('chat.actionEnableReminderTitle')"
    :confirm-label="$t('chat.actionEnableReminderConfirm')"
    :done-label="$t('chat.actionEnableReminderDone')"
    :error-label="$t('chat.actionEnableReminderError')"
    @confirm="onConfirm"
  >
    <template #head-end>
      <input
        v-model="chosenTime"
        type="time"
        class="time-input"
        :disabled="state === 'executing' || state === 'done'"
        :aria-label="$t('chat.actionEnableReminderTitle')"
      />
    </template>
    <p class="body">{{ $t("chat.actionEnableReminderBody") }}</p>
  </ActionCardShell>
</template>

<style scoped>
.time-input {
  flex: 0 0 auto;
  padding: 4px 8px;
  border-radius: 8px;
  font-variant-numeric: tabular-nums;
  font-size: 15px;
  background: rgba(var(--ion-color-primary-rgb), 0.12);
  color: var(--ion-color-primary);
  border: 1px solid rgba(var(--ion-color-primary-rgb), 0.28);
  appearance: none;
  /* iOS / Android both render a native time picker via the input;
   * styling here just gives the field a consistent chip-like surface. */
}

.time-input:disabled {
  opacity: 0.6;
}
</style>
