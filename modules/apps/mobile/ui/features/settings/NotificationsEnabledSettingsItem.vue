<template>
  <IonItem lines="none">
    <div slot="start" class="settings-item-icon">
      <BellIcon />
    </div>

    <IonLabel class="ion-text-nowrap">
      <h2>{{ $t("settings.notifications.enabled.title") }}</h2>
      <p>{{ $t("settings.notifications.enabled.description") }}</p>
    </IonLabel>

    <IonToggle slot="end" v-model="value" label-placement="start" />
  </IonItem>
</template>

<script setup lang="ts">
import { IonItem, IonLabel, IonToggle } from "@ionic/vue"
import { BellIcon } from "@ui/icons/index.js"

const value = defineModel<boolean>({ required: true, default: false })
</script>
