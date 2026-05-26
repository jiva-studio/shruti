<template>
  <IonItem lines="none">
    <IconChip slot="start">
      <ClockIcon />
    </IconChip>

    <IonLabel class="ion-text-nowrap">
      <h2>{{ $t("settings.player.showProgress.title") }}</h2>
      <p>{{ $t("settings.player.showProgress.description") }}</p>
    </IonLabel>

    <IonToggle slot="end" v-model="value" label-placement="start" />
  </IonItem>
</template>

<script setup lang="ts">
import { IonItem, IonLabel, IonToggle } from "@ionic/vue"
// Distinct from the play-triangle on the "show player on notes page" row —
// having both rows render the same triangle made the list read as a dup.
import { ClockIcon } from "@ui/icons/index.js"
import { IconChip } from "@ui/primitives/index.js"

const value = defineModel<boolean>({ required: true, default: true })
</script>
