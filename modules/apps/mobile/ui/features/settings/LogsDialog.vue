<template>
  <IonModal class="logs-dialog" :is-open="open" @did-dismiss="open = false">
    <Header>
      <IonToolbar>
        <IonButtons slot="start">
          <IonButton shape="round" size="small" :disabled="count === 0" @click="emit('copy')">
            {{ $t("settings.logs.copy") }}
          </IonButton>
        </IonButtons>
        <IonTitle>{{ $t("settings.logs.title") }}</IonTitle>
        <IonButtons slot="end">
          <IonButton shape="round" size="small" @click="open = false">
            {{ $t("settings.logs.close") }}
          </IonButton>
        </IonButtons>
      </IonToolbar>
    </Header>

    <IonContent>
      <div v-if="count === 0" class="logs-empty">
        {{ $t("settings.logs.empty") }}
      </div>
      <div v-else class="logs-list">
        <div
          v-for="entry in entries"
          :key="entry.id"
          class="logs-line"
          :class="`logs-line--${entry.level}`"
        >
          <span class="logs-line__ts">{{ formatTime(entry.ts) }}</span>
          <span class="logs-line__lvl">{{ entry.level.charAt(0).toUpperCase() }}</span>
          <span class="logs-line__text">{{ entry.text }}</span>
        </div>
      </div>
    </IonContent>

    <IonFooter v-if="count > 0">
      <IonToolbar>
        <IonButtons slot="end">
          <IonButton color="danger" size="small" @click="emit('clear')">
            {{ $t("settings.logs.clear") }}
          </IonButton>
        </IonButtons>
        <IonTitle size="small" class="logs-count">
          {{ $t("settings.logs.count", { count }) }}
        </IonTitle>
      </IonToolbar>
    </IonFooter>
  </IonModal>
</template>

<script setup lang="ts">
import {
  IonButton,
  IonButtons,
  IonContent,
  IonFooter,
  IonModal,
  IonTitle,
  IonToolbar,
} from "@ionic/vue"
import { Header } from "@ui/primitives/index.js"

/**
 * Presentational debug-log viewer. The host (composition root) owns the log
 * buffer / store and the copy-to-clipboard side effect — this component only
 * renders the lines (already newest-first) and surfaces `copy` / `clear`.
 */
interface LogLineVm {
  id: number
  ts: number
  level: string
  text: string
}

const open = defineModel<boolean>("open", { required: true, default: false })

defineProps<{
  /** Lines to render, newest-first. */
  entries: readonly LogLineVm[]
  /** Total buffered line count. */
  count: number
}>()

const emit = defineEmits<{
  copy: []
  clear: []
}>()

function formatTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number, w = 2): string => String(n).padStart(w, "0")
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}
</script>

<style scoped>
.logs-empty {
  padding: 24px 16px;
  text-align: center;
  color: var(--ion-color-medium);
  font-size: 14px;
}

.logs-list {
  padding: 8px 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.45;
}

.logs-line {
  display: flex;
  gap: 6px;
  padding: 1px 12px;
  white-space: pre-wrap;
  word-break: break-word;
  border-bottom: 1px solid var(--ion-color-step-100, rgba(0, 0, 0, 0.05));
}

.logs-line__ts {
  flex: 0 0 auto;
  color: var(--ion-color-medium);
}

.logs-line__lvl {
  flex: 0 0 auto;
  width: 1ch;
  font-weight: 700;
}

.logs-line__text {
  flex: 1 1 auto;
}

.logs-line--warn .logs-line__lvl,
.logs-line--warn .logs-line__text {
  color: var(--ion-color-warning-shade, #b26a00);
}

.logs-line--error .logs-line__lvl,
.logs-line--error .logs-line__text {
  color: var(--ion-color-danger, #c0392b);
}

.logs-line--debug {
  opacity: 0.65;
}

.logs-count {
  font-size: 12px;
  color: var(--ion-color-medium);
  text-align: start;
  padding-inline-start: 12px;
}
</style>

<style>
/* Flat sheet — same elevation kill as HelpDialog. */
.logs-dialog ion-header,
.logs-dialog ion-header::after {
  box-shadow: none !important;
  background-image: none;
}
.logs-dialog ion-header::after {
  display: none;
}
</style>
