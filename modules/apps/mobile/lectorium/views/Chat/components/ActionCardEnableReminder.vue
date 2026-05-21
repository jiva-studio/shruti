<template>
  <section v-if="payload" class="action-card reminder">
    <header class="head">
      <span class="name">{{ $t("chat.actionEnableReminderTitle") }}</span>
      <input
        v-model="chosenTime"
        type="time"
        class="time-input"
        :disabled="state === 'executing' || state === 'done'"
        :aria-label="$t('chat.actionEnableReminderTitle')"
      />
    </header>
    <p class="body">{{ $t("chat.actionEnableReminderBody") }}</p>
    <footer class="footer">
      <span v-if="state === 'done'" class="hint">{{ $t("chat.actionEnableReminderDone") }}</span>
      <span v-else-if="state === 'error'" class="hint error">
        {{ $t("chat.actionEnableReminderError") }}
      </span>
      <button v-if="state === 'pending'" class="btn primary" @click="onConfirm">
        {{ $t("chat.actionEnableReminderConfirm") }}
      </button>
      <button v-else-if="state === 'executing'" class="btn primary" disabled>
        <IonSpinner name="dots" class="spinner" />
      </button>
      <button v-else-if="state === 'error'" class="btn primary" @click="onConfirm">
        {{ $t("chat.actionRetry") }}
      </button>
    </footer>
  </section>
  <section v-else class="action-card reminder broken">
    <span class="broken-icon">⚠</span>
    <span class="broken-text">{{ $t("chat.actionDegraded") }}</span>
  </section>
</template>

<script setup lang="ts">
import { ref, watch } from "vue"
import { IonSpinner } from "@ionic/vue"
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

const chosenTime = ref<string>(props.payload?.time ?? "07:00")
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

<style scoped>
.action-card.reminder {
  margin: 8px 0;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid rgba(var(--ion-color-primary-rgb), 0.28);
  background: rgba(var(--ion-color-primary-rgb), 0.06);
}

.action-card.broken {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--ion-color-medium);
  border: 1px dashed rgba(var(--ion-color-medium-rgb, 146, 148, 156), 0.5);
  background: transparent;
}

.broken-icon {
  flex: 0 0 auto;
  opacity: 0.8;
}

.broken-text {
  flex: 1 1 auto;
  min-width: 0;
}

.head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 4px;
}

.name {
  font-weight: 600;
  font-size: 15px;
  flex: 1 1 auto;
}

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

.body {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--ion-color-medium);
  line-height: 1.35;
}

.footer {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
  min-height: 36px;
}

.btn {
  appearance: none;
  border: 0;
  border-radius: 10px;
  padding: 6px 14px;
  font-size: 13px;
  font-weight: 500;
  min-height: 30px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.btn.primary {
  background: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
}

.btn.primary[disabled] {
  opacity: 0.6;
  cursor: default;
}

.spinner {
  width: 18px;
  height: 14px;
}

.hint {
  flex: 0 0 auto;
  font-size: 13px;
  padding: 6px 4px;
  opacity: 0.6;
}

.hint.error {
  color: var(--ion-color-danger, #eb445a);
  opacity: 0.85;
}
</style>
