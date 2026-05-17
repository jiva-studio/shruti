<template>
  <section v-if="payload" class="action-card note">
    <header class="head">
      <span class="kind">{{ $t("chat.actionNoteKind") }}</span>
      <span class="meta">{{ metaLine }}</span>
    </header>
    <blockquote class="quote">{{ payload.text }}</blockquote>

    <footer v-if="state !== 'done'" class="actions">
      <span v-if="state === 'error'" class="done-text error">
        {{ $t("chat.actionNoteError") }}
      </span>
      <button
        v-if="state === 'pending'"
        class="btn primary"
        @click="onConfirm"
      >
        {{ $t("chat.actionNoteConfirm") }}
      </button>
      <button
        v-else-if="state === 'executing'"
        class="btn primary"
        disabled
      >
        <IonSpinner name="dots" class="spinner" />
      </button>
      <button
        v-else-if="state === 'error'"
        class="btn primary"
        @click="onConfirm"
      >
        {{ $t("chat.actionRetry") }}
      </button>
    </footer>
  </section>
  <section v-else class="action-card note broken">
    <span class="broken-icon">⚠</span>
    <span class="broken-text">{{ $t("chat.actionDegraded") }}</span>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue"
import { useRouter } from "vue-router"
import { IonSpinner } from "@ionic/vue"
import type { ActionPayload } from "@lectorium/services/chatClient.js"
import type { ActionState } from "@lectorium/stores/useChatStore.js"

const props = defineProps<{
  actionId: string
  payload?: Extract<ActionPayload, { kind: "save_note" }>
  state: ActionState
}>()

const emit = defineEmits<{
  (e: "confirm", actionId: string): void
}>()

const router = useRouter()

const metaLine = computed(() => {
  if (!props.payload) return ""
  return formatTs(props.payload.startMs)
})

function formatTs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n))
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

function onConfirm() { emit("confirm", props.actionId) }
function openNotes() { void router.push({ name: "notes" }) }
</script>

<style scoped>
.action-card.note {
  margin: 10px 0;
  padding: 12px 14px 10px;
  border-radius: 14px;
  border: 1px solid rgba(var(--ion-color-warning-rgb, 255, 196, 9), 0.32);
  background: rgba(var(--ion-color-warning-rgb, 255, 196, 9), 0.06);
}

/* Broken — same muted placeholder as ActionCardPlaylist. Marker arrived
 * without a payload; rather than hiding we show the user that something
 * misfired so the issue is debuggable. */
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

.action-card.degraded {
  padding: 12px 14px;
  opacity: 0.5;
  font-size: 13px;
}

.head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 8px;
}

.kind {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.7;
}

.meta {
  font-size: 12px;
  opacity: 0.55;
  font-variant-numeric: tabular-nums;
}

.quote {
  margin: 0 0 10px;
  padding: 8px 12px;
  border-left: 3px solid rgba(var(--ion-color-warning-rgb, 255, 196, 9), 0.55);
  font-style: italic;
  font-size: 14px;
  line-height: 1.4;
  background: rgba(var(--ion-color-warning-rgb, 255, 196, 9), 0.04);
}

.actions, .status {
  display: flex;
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
  line-height: 1.2;
  white-space: nowrap;
  flex-shrink: 0;
  cursor: pointer;
}

.btn.primary {
  background: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
}

.btn.primary[disabled] {
  opacity: 0.6;
  cursor: default;
}

.btn.ghost {
  background: transparent;
  color: var(--ion-color-primary);
  padding: 6px 8px;
}

.btn.small {
  padding: 6px 10px;
  font-size: 13px;
}

.done-text {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  line-height: 1.25;
}

.status.done .check {
  color: var(--ion-color-success, #2dd36f);
  font-weight: 700;
  flex-shrink: 0;
}

.status.error { color: var(--ion-color-danger, #eb445a); flex-wrap: wrap; }
</style>
