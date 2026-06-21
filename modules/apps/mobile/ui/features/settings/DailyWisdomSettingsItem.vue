<template>
  <IonItem button detail lines="none" @click="emit('click')">
    <IconChip slot="start">
      <IconSparkles :size="22" />
    </IconChip>

    <IonLabel class="ion-text-nowrap">
      <h2>{{ $t("settings.dailyWisdom.title") }}</h2>
      <p>{{ subtitle }}</p>
    </IonLabel>
  </IonItem>
</template>

<script setup lang="ts">
import { IonItem, IonLabel } from "@ionic/vue"
import { IconSparkles } from "@tabler/icons-vue"
import { IconChip } from "@ui/primitives/index.js"

defineProps<{ subtitle: string }>()

const emit = defineEmits<{ click: [] }>()
</script>
