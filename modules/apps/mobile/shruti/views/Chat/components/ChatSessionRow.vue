<script setup lang="ts">
import { IonItem, IonItemOption, IonItemOptions, IonItemSliding, IonLabel } from "@ionic/vue"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import type { ChatSession } from "@shruti/stores/useChatStore.js"

const props = defineProps<{
  session: ChatSession
  active: boolean
  unread: boolean
}>()

const emit = defineEmits<{
  pick: []
  delete: []
}>()

const appLanguage = useAppLanguage()

function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms)) return ""
  return new Date(ms).toLocaleString(appLanguage.value, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function onPick(): void {
  emit("pick")
}

function onDelete(): void {
  emit("delete")
}
</script>

<template>
  <IonItemSliding>
    <IonItem button :detail="false" :class="{ active }" @click="onPick">
      <IonLabel>
        <h3 class="title">
          <span v-if="unread" class="unread-dot" aria-hidden="true" />
          {{ props.session.title || $t("chat.untitledSession") }}
        </h3>
        <p class="meta">{{ formatTimestamp(props.session.updatedAt) }}</p>
      </IonLabel>
    </IonItem>
    <IonItemOptions side="end">
      <IonItemOption color="danger" @click="onDelete">
        {{ $t("app.delete") }}
      </IonItemOption>
    </IonItemOptions>
  </IonItemSliding>
</template>

<style scoped>
.title {
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.unread-dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ion-color-primary, #3880ff);
}

.meta {
  font-size: 12px;
  color: var(--ion-color-step-500, #8a8a8a);
}

.active {
  --background: rgba(var(--ion-color-primary-rgb), 0.08);
}
</style>
