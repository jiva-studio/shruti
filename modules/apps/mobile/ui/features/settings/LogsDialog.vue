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
import LogsDialogLine from "./LogsDialogLine.vue"

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

defineProps<{
  /** Lines to render, newest-first. */
  entries: readonly LogLineVm[]
  /** Total buffered line count. */
  count: number
}>()

const open = defineModel<boolean>("open", { required: true, default: false })

const emit = defineEmits<{
  copy: []
  clear: []
}>()
</script>

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
        <LogsDialogLine
          v-for="entry in entries"
          :key="entry.id"
          :ts="entry.ts"
          :level="entry.level"
          :text="entry.text"
        />
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
