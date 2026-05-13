<template>
  <IonItem lines="none">
    <IconChip slot="start">
      <IconPlay />
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
import { IconPlay } from "@ui/icons/index.js"
import { IconChip } from "@ui/primitives/index.js"

const value = defineModel<boolean>({ required: true, default: true })
</script>
