<template>
  <IonItem lines="none">
    <div slot="start" class="settings-item-icon">
      <IconBookmark />
    </div>

    <IonLabel class="ion-text-nowrap">
      <h2>{{ $t("settings.notes.showTab.title") }}</h2>
      <p>{{ $t("settings.notes.showTab.description") }}</p>
    </IonLabel>

    <IonToggle slot="end" v-model="value" label-placement="start" />
  </IonItem>
</template>

<script setup lang="ts">
import { IonItem, IonLabel, IonToggle } from "@ionic/vue"
import { IconBookmark } from "@ui/icons/index.js"

const value = defineModel<boolean>({ required: true, default: true })
</script>
