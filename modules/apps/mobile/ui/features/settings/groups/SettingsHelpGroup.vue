<template>
  <IonListHeader>
    <IonLabel>{{ $t("settings.groups.help") }}</IonLabel>
  </IonListHeader>

  <IonItem button :detail="true" lines="none" @click="emit('openHelp')">
    <IconChip slot="start">
      <HelpIcon />
    </IconChip>
    <IonLabel class="ion-text-nowrap">
      <h2>{{ $t("settings.help.open.title") }}</h2>
      <p>{{ $t("settings.help.open.description") }}</p>
    </IonLabel>
  </IonItem>

  <IonItem button :detail="true" lines="none" @click="emit('openPrivacyPolicy')">
    <IconChip slot="start">
      <ShieldIcon />
    </IconChip>
    <IonLabel class="ion-text-nowrap">
      <h2>{{ $t("settings.help.privacyPolicy.title") }}</h2>
      <p>{{ $t("settings.help.privacyPolicy.description") }}</p>
    </IonLabel>
  </IonItem>
</template>

<script setup lang="ts">
import { IonItem, IonLabel, IonListHeader } from "@ionic/vue"
import { HelpIcon, ShieldIcon } from "@ui/icons/index.js"
import { IconChip } from "@ui/primitives/index.js"

const emit = defineEmits<{
  openHelp: []
  openPrivacyPolicy: []
}>()
</script>
