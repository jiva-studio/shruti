<template>
  <IonModal :is-open="open" class="daily-wisdom-dialog" @did-dismiss="onClose">
    <Header class="flat-header">
      <IonToolbar>
        <IonTitle>{{ $t("settings.dailyWisdom.title") }}</IonTitle>
        <IonButtons slot="end">
          <IonButton strong @click="onClose">{{ $t("app.ok") }}</IonButton>
        </IonButtons>
      </IonToolbar>
    </Header>

    <IonContent>
      <p class="hint">{{ $t("settings.dailyWisdom.hint") }}</p>

      <div v-if="topics.length > 0" class="chips">
        <ToggleChip v-for="t in topics" :key="t.id" :selected="isOn(t.id)" @toggle="toggle(t.id)">
          {{ t.label }}
        </ToggleChip>
      </div>
      <p v-else class="hint empty">{{ $t("settings.dailyWisdom.empty") }}</p>
    </IonContent>
  </IonModal>
</template>

<script setup lang="ts">
import { IonModal, IonToolbar, IonTitle, IonButtons, IonButton, IonContent } from "@ionic/vue"
import { Header, ToggleChip } from "@ui/primitives/index.js"

defineProps<{
  open: boolean
  topics: readonly { id: string; label: string }[]
}>()

const selected = defineModel<string[]>("selected", { required: true })

const emit = defineEmits<{ "update:open": [open: boolean] }>()

function isOn(id: string): boolean {
  return selected.value.includes(id)
}

function toggle(id: string): void {
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected.value = [...next]
}

function onClose(): void {
  emit("update:open", false)
}
</script>

<style scoped>
.hint {
  margin: 12px 16px 16px;
  font-size: 0.9rem;
  line-height: 1.45;
  color: var(--ion-color-medium);
}
.hint.empty {
  text-align: center;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding: 0 16px 24px;
}
</style>
