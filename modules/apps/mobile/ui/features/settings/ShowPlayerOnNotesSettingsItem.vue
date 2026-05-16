<template>
  <IonItem lines="none">
    <IconChip slot="start">
      <IconPlayerPlayFilled :size="22" />
    </IconChip>
    <IonLabel class="ion-text-nowrap">
      <h2>{{ $t("settings.notes.showPlayer.title") }}</h2>
      <p>{{ $t("settings.notes.showPlayer.description") }}</p>
    </IonLabel>
    <IonToggle v-model="value" slot="end" />
  </IonItem>
</template>

<script setup lang="ts">
import { IonItem, IonLabel, IonToggle } from "@ionic/vue"
import { IconPlayerPlayFilled } from "@tabler/icons-vue"
import { IconChip } from "@ui/primitives/index.js"

const value = defineModel<boolean>({ required: true, default: false })
</script>
