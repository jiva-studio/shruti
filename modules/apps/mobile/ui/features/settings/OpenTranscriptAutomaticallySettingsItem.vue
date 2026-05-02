<template>
  <IonItem lines="none">
    <!-- Item Icon -->
    <div slot="start" class="settings-item-icon">
      <AnnotationIcon />
    </div>

    <!-- Text Label -->
    <IonLabel class="ion-text-nowrap">
      <h2>{{ $t("settings.transcript.showAutomatically.title") }}</h2>
      <p>{{ $t("settings.transcript.showAutomatically.description") }}</p>
    </IonLabel>

    <!-- Toggle -->
    <IonToggle slot="end" v-model="value" label-placement="start" />
  </IonItem>
</template>

<script setup lang="ts">
import { IonItem, IonLabel, IonToggle } from "@ionic/vue"
import { AnnotationIcon } from "@ui/icons/index.js"

const value = defineModel<boolean>({ required: true, default: false })
</script>
