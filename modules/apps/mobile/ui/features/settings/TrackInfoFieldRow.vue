<script setup lang="ts">
import { IonItem, IonLabel, IonReorder, IonToggle } from "@ionic/vue"

defineProps<{ label: string; enabled: boolean }>()

const emit = defineEmits<{ toggle: [enabled: boolean] }>()

function onChange(ev: CustomEvent): void {
  emit("toggle", (ev.detail as { checked: boolean }).checked)
}
</script>

<template>
  <IonItem>
    <IonReorder slot="start" />
    <IonLabel>{{ label }}</IonLabel>
    <IonToggle slot="end" :checked="enabled" label-placement="start" @ion-change="onChange" />
  </IonItem>
</template>
