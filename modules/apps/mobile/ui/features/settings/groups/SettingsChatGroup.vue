<template>
  <IonListHeader>
    <IonLabel>{{ $t("chat.title") }}</IonLabel>
  </IonListHeader>

  <IonItem lines="none">
    <IconChip slot="start">
      <IconMessageCircle />
    </IconChip>
    <IonLabel class="ion-text-nowrap">
      <h2>{{ $t("settings.chat.showTab.title") }}</h2>
      <p>{{ $t("settings.chat.showTab.description") }}</p>
    </IonLabel>
    <IonToggle slot="end" v-model="showChatTab" label-placement="start" />
  </IonItem>

  <IonItem v-if="showChatTab" button :detail="false" lines="none" @click="emit('clearChatHistory')">
    <IconChip slot="start" danger>
      <TrashIcon />
    </IconChip>
    <IonLabel class="ion-text-nowrap clear-history-label">
      <h2>{{ $t("settings.chat.clearHistory.title") }}</h2>
      <p>{{ $t("settings.chat.clearHistory.description") }}</p>
    </IonLabel>
  </IonItem>
</template>

<script setup lang="ts">
import { IonItem, IonLabel, IonListHeader, IonToggle } from "@ionic/vue"
import { IconMessageCircle } from "@tabler/icons-vue"
import { TrashIcon } from "@ui/icons/index.js"
import { IconChip } from "@ui/primitives/index.js"

const showChatTab = defineModel<boolean>("showChatTab", { required: true })

const emit = defineEmits<{
  clearChatHistory: []
}>()
</script>

<style scoped>
.clear-history-label :deep(h2) {
  color: var(--ion-color-danger);
}
</style>
