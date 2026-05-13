<template>
  <IonItem lines="none">
    <IconChip slot="start">
      <FlameIcon />
    </IconChip>

    <IonLabel class="ion-text-nowrap">
      <h2>{{ $t("settings.activityTracker.show.title") }}</h2>
      <p>{{ $t("settings.activityTracker.show.description") }}</p>
    </IonLabel>

    <IonToggle slot="end" v-model="value" label-placement="start" />
  </IonItem>
</template>

<script setup lang="ts">
import { IonItem, IonLabel, IonToggle } from "@ionic/vue"
import { FlameIcon } from "@ui/icons/index.js"
import { IconChip } from "@ui/primitives/index.js"

const value = defineModel<boolean>({ required: true, default: true })
</script>
