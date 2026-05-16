<template>
  <IonItem lines="none">
    <IconChip slot="start">
      <IconSparklesFilled :size="22" />
    </IconChip>
    <IonLabel class="ion-text-nowrap">
      <h2>
        {{ $t("settings.notes.studio.title") }}
        <ProBadge />
      </h2>
      <p>{{ $t("settings.notes.studio.description") }}</p>
    </IonLabel>
    <IonToggle v-model="value" slot="end" />
  </IonItem>
</template>

<script setup lang="ts">
import { IonItem, IonLabel, IonToggle } from "@ionic/vue"
import { IconSparklesFilled } from "@tabler/icons-vue"
import { IconChip, ProBadge } from "@ui/primitives/index.js"

const value = defineModel<boolean>({ required: true, default: true })
</script>
