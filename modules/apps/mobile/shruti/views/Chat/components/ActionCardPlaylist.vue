<template>
  <section v-if="payload" class="action-card playlist">
    <header class="head">
      <span class="name">«{{ payload.name }}»</span>
    </header>

    <div class="rows">
      <TrackMiniRow
        v-for="id in visibleIds"
        :key="id"
        :track-id="id"
      />
      <button v-if="hiddenCount > 0" type="button" class="more" @click="expanded = true">
        {{ $t("chat.actionPlaylistMore", { n: hiddenCount }) }}
      </button>
    </div>

    <footer class="footer">
      <span v-if="state === 'done'" class="hint">
        {{ $t("chat.actionPlaylistDone") }}
      </span>
      <span v-else-if="state === 'error'" class="hint error">
        {{ $t("chat.actionPlaylistError") }}
      </span>
      <button
        v-if="state === 'pending'"
        class="btn primary"
        @click="onConfirm"
      >
        {{ $t("chat.actionPlaylistConfirm") }}
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
  <section v-else class="action-card playlist broken">
    <span class="broken-icon">⚠</span>
    <span class="broken-text">{{ $t("chat.actionDegraded") }}</span>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from "vue"
import { useRouter } from "vue-router"
import { IonSpinner } from "@ionic/vue"
import TrackMiniRow from "./TrackMiniRow.vue"
import type { ActionPayload } from "@shruti/services/chatClient.js"
import type { ActionState } from "@shruti/stores/useChatStore.js"

const props = defineProps<{
  actionId: string
  payload?: Extract<ActionPayload, { kind: "create_playlist" }>
  state: ActionState
}>()

const emit = defineEmits<{
  (e: "confirm", actionId: string): void
}>()

const router = useRouter()

const COLLAPSED_LIMIT = 5
const expanded = ref(false)
const hiddenCount = computed(() => {
  if (!props.payload) return 0
  if (expanded.value) return 0
  return Math.max(0, props.payload.trackIds.length - COLLAPSED_LIMIT)
})
const visibleIds = computed(() => {
  if (!props.payload) return []
  return expanded.value
    ? props.payload.trackIds
    : props.payload.trackIds.slice(0, COLLAPSED_LIMIT)
})

function onConfirm() {
  emit("confirm", props.actionId)
}

function openLibrary() {
  void router.push({ name: "home" })
}
</script>

<style scoped>
.action-card.playlist {
  margin: 8px 0;
  padding: 0;
  border-radius: 12px;
  border: 1px solid rgba(var(--ion-color-primary-rgb), 0.28);
  background: rgba(var(--ion-color-primary-rgb), 0.06);
  overflow: hidden;
}

/* Broken/degraded: LLM emitted the marker but the matching `event: action`
 * payload was lost (network glitch, model invented an id, ...).
 * We render a muted placeholder rather than hiding silently — the user
 * sees something happened and a future debug pass can investigate. */
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
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding: 10px 12px 4px;
}

.kind {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.6;
}

.name {
  font-weight: 600;
  font-size: 16px;
  line-height: 1.25;
}

.rows {
  display: flex;
  flex-direction: column;
  padding: 4px 0;
}

.more {
  display: block;
  margin: 0;
  padding: 8px 12px;
  background: transparent;
  border: 0;
  text-align: left;
  color: var(--ion-color-primary);
  cursor: pointer;
  font-size: 13px;
}

/* Tight, equal gutter so the button sits the same distance from the
 * card's right and bottom edges. */
.footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding: 6px;
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
  min-height: 30px;
  white-space: nowrap;
  flex-shrink: 0;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.spinner {
  width: 18px;
  height: 14px;
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

/* The "done" / error hint sits where the button was, same vertical
 * footprint — no layout jump when the button disappears. */
.hint {
  flex: 0 0 auto;
  font-size: 13px;
  line-height: 1.2;
  padding: 6px 4px;
  min-height: 30px;
  display: inline-flex;
  align-items: center;
  opacity: 0.6;
}

.hint.error {
  color: var(--ion-color-danger, #eb445a);
  opacity: 0.85;
}
</style>
