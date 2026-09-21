<script setup lang="ts">
import { IonItem, IonLabel, IonList, IonListHeader, IonRadio, IonRadioGroup } from "@ionic/vue"

defineProps<{
  title: string
  options: readonly { value: string; label: string }[]
  selected?: string
  disabled: boolean
}>()

const emit = defineEmits<{ pick: [value: string] }>()

function onChange(ev: CustomEvent): void {
  const value = (ev.detail as { value?: string }).value
  if (value) emit("pick", value)
}
</script>

<template>
  <IonListHeader>
    <IonLabel>{{ title }}</IonLabel>
  </IonListHeader>
  <IonList lines="none" class="ion-no-margin ion-no-padding">
    <IonRadioGroup :model-value="selected" @ion-change="onChange">
      <IonItem v-for="opt in options" :key="opt.value" :disabled="disabled">
        <IonRadio :value="opt.value">{{ opt.label }}</IonRadio>
      </IonItem>
    </IonRadioGroup>
  </IonList>
</template>
