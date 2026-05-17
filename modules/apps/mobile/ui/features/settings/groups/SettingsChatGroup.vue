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
</template>

<script setup lang="ts">
import { IonItem, IonLabel, IonListHeader, IonToggle } from "@ionic/vue"
import { IconMessageCircle } from "@tabler/icons-vue"
import { IconChip } from "@ui/primitives/index.js"

const showChatTab = defineModel<boolean>("showChatTab", { required: true })
</script>
