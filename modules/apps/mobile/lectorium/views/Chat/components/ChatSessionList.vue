<template>
  <IonModal :is-open="open" class="chat-session-list" @did-dismiss="$emit('update:open', false)">
    <Header>
      <IonToolbar>
        <IonTitle>{{ $t("chat.history") }}</IonTitle>
        <IonButtons slot="end">
          <IonButton @click="$emit('update:open', false)">
            {{ $t("app.close") }}
          </IonButton>
        </IonButtons>
      </IonToolbar>
    </Header>
    <IonContent>
      <IonList v-if="sessions.length > 0">
        <IonItemSliding v-for="session in sessions" :key="session.id">
          <IonItem
            button
            :detail="false"
            :class="{ active: session.id === activeSessionId }"
            @click="onPick(session.id)"
          >
            <IonLabel>
              <h3 class="title">{{ session.title || $t("chat.untitledSession") }}</h3>
              <p class="meta">{{ formatTimestamp(session.updatedAt) }}</p>
            </IonLabel>
          </IonItem>
          <IonItemOptions side="end">
            <IonItemOption color="danger" @click="$emit('delete', session.id)">
              {{ $t("app.delete") }}
            </IonItemOption>
          </IonItemOptions>
        </IonItemSliding>
      </IonList>
      <div v-else class="empty">
        {{ $t("chat.historyEmpty") }}
      </div>
    </IonContent>
  </IonModal>
</template>

<script setup lang="ts">
import {
  IonButton,
  IonButtons,
  IonContent,
  IonItem,
  IonItemOption,
  IonItemOptions,
  IonItemSliding,
  IonLabel,
  IonList,
  IonModal,
  IonTitle,
  IonToolbar,
} from "@ionic/vue"
import { Header } from "@ui/primitives/index.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import type { ChatSession } from "@lectorium/stores/useChatStore.js"

defineProps<{
  open: boolean
  sessions: readonly ChatSession[]
  activeSessionId: string | null
}>()

const emit = defineEmits<{
  "update:open": [value: boolean]
  pick: [id: string]
  delete: [id: string]
}>()

const appLanguage = useAppLanguage()

function onPick(id: string): void {
  emit("pick", id)
}

function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms)) return ""
  const d = new Date(ms)
  return d.toLocaleString(appLanguage.value, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}
</script>

<style scoped>
.title {
  font-weight: 500;
}

.meta {
  font-size: 12px;
  color: var(--ion-color-step-500, #8a8a8a);
}

.active {
  --background: rgba(var(--ion-color-primary-rgb), 0.08);
}

.empty {
  padding: 48px 24px;
  text-align: center;
  color: var(--ion-color-step-500, #8a8a8a);
}
</style>

<style>
/* Kill the Material elevation under the toolbar so the sheet reads
   as a flat surface. iOS hairline is already removed by the Header
   primitive's `ion-no-border`. */
.chat-session-list ion-header,
.chat-session-list ion-header::after {
  box-shadow: none !important;
  background-image: none;
}
.chat-session-list ion-header::after {
  display: none;
}
</style>
