<script setup lang="ts">
import { IonButton, IonButtons, IonTitle, IonToolbar } from "@ionic/vue"
import { IconArrowLeft } from "@tabler/icons-vue"
import { FlatHeader } from "@ui/primitives/index.js"

defineProps<{ title: string }>()
const emit = defineEmits<{ back: [] }>()
</script>

<template>
  <FlatHeader>
    <IonToolbar>
      <IonButtons slot="start">
        <IonButton :aria-label="$t('app.back')" @click="emit('back')">
          <IconArrowLeft :size="22" />
        </IonButton>
      </IonButtons>
      <IonTitle>{{ title }}</IonTitle>
    </IonToolbar>
  </FlatHeader>
</template>
