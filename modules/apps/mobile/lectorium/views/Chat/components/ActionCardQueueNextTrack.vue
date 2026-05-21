<template>
  <section v-if="payload" class="action-card queue-next">
    <header class="head">
      <span class="name">{{ $t("chat.actionQueueNextTrackTitle") }}</span>
    </header>
    <TrackMiniRow :track-id="payload.trackId" />
    <footer class="footer">
      <span v-if="state === 'done'" class="hint">{{ $t("chat.actionQueueNextTrackDone") }}</span>
      <span v-else-if="state === 'error'" class="hint error">
        {{ $t("chat.actionQueueNextTrackError") }}
      </span>
      <button v-if="state === 'pending'" class="btn primary" @click="onConfirm">
        {{ $t("chat.actionQueueNextTrackConfirm") }}
      </button>
      <button v-else-if="state === 'executing'" class="btn primary" disabled>
        <IonSpinner name="dots" class="spinner" />
      </button>
      <button v-else-if="state === 'error'" class="btn primary" @click="onConfirm">
        {{ $t("chat.actionRetry") }}
      </button>
    </footer>
  </section>
  <section v-else class="action-card queue-next broken">
    <span class="broken-icon">⚠</span>
    <span class="broken-text">{{ $t("chat.actionDegraded") }}</span>
  </section>
</template>

<script setup lang="ts">
import { IonSpinner } from "@ionic/vue"
import TrackMiniRow from "./TrackMiniRow.vue"
import type { ChatActionPayload } from "@lib/domain/chatMessage.js"
import type { ActionState } from "@lectorium/stores/useChatStore.js"

const props = defineProps<{
  actionId: string
  payload?: Extract<ChatActionPayload, { kind: "queue_next_track" }>
  state: ActionState
}>()

const emit = defineEmits<{
  (e: "confirm", actionId: string): void
}>()

function onConfirm() {
  emit("confirm", props.actionId)
}
</script>

<style scoped>
.action-card.queue-next {
  margin: 8px 0;
  padding: 8px 12px 6px;
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
  margin-bottom: 4px;
}

.name {
  font-weight: 600;
  font-size: 15px;
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
