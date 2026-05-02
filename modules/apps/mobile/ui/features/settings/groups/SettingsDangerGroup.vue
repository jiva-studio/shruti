<template>
  <IonListHeader>
    <IonLabel>{{ $t("settings.groups.danger") }}</IonLabel>
  </IonListHeader>
  <IonItem button :detail="false" lines="none" @click="emit('clearCache')">
    <IonLabel color="danger">{{ $t("settings.danger.clearCache") }}</IonLabel>
  </IonItem>
  <IonItem button :detail="false" lines="none" @click="emit('clearUserData')">
    <IonLabel color="danger">{{ $t("settings.danger.clearUserData") }}</IonLabel>
  </IonItem>
</template>

<script setup lang="ts">
import { IonItem, IonLabel, IonListHeader } from "@ionic/vue"

const emit = defineEmits<{
  clearCache: []
  clearUserData: []
}>()
</script>
