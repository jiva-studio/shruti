<template>
  <IonList v-if="languages.length">
    <IonItem>
      <IonLabel>{{ label ?? "Language" }}</IonLabel>
      <IonSelect
        :value="value"
        interface="popover"
        @ion-change="(e: CustomEvent<{ value: string }>) => emit('update:value', e.detail.value)"
      >
        <IonSelectOption v-for="lang in languages" :key="lang" :value="lang">
          {{ lang }}
        </IonSelectOption>
      </IonSelect>
    </IonItem>
  </IonList>
</template>

<script setup lang="ts">
import { IonItem, IonLabel, IonList, IonSelect, IonSelectOption } from "@ionic/vue"

defineProps<{
  /** Language codes to choose from. Renders nothing when empty. */
  languages: readonly string[]
  /** Currently selected language code. */
  value: string | null | undefined
  /** Optional override for the row label. */
  label?: string
}>()

const emit = defineEmits<{
  "update:value": [language: string]
}>()
</script>
