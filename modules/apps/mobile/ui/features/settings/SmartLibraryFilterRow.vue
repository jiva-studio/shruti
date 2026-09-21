<script setup lang="ts">
import { IonItem, IonLabel } from "@ionic/vue"
import { IconFilterFilled } from "@tabler/icons-vue"
import { IconChip } from "@ui/primitives/index.js"

defineProps<{ label: string; summary: string; disabled: boolean }>()

const emit = defineEmits<{ activate: [] }>()
</script>

<template>
  <IonItem button detail :disabled="disabled" @click="emit('activate')">
    <IconChip slot="start">
      <IconFilterFilled :size="22" />
    </IconChip>
    <IonLabel class="ion-text-nowrap">
      <h2>{{ label }}</h2>
      <p>{{ summary }}</p>
    </IonLabel>
  </IonItem>
</template>
