<script setup lang="ts">
import { IonButton, IonButtons, IonTitle, IonToolbar } from "@ionic/vue"
import { TrashIcon } from "@ui/icons/index.js"

defineProps<{ canClear: boolean }>()
const emit = defineEmits<{ "delete-all": []; close: [] }>()
</script>

<template>
  <IonToolbar>
    <IonTitle>{{ $t("chat.history") }}</IonTitle>
    <IonButtons slot="end">
      <IonButton
        color="danger"
        :disabled="!canClear"
        :aria-label="$t('chat.clearHistory')"
        @click="emit('delete-all')"
      >
        <TrashIcon :size="20" />
      </IonButton>
      <IonButton @click="emit('close')">
        {{ $t("app.close") }}
      </IonButton>
    </IonButtons>
  </IonToolbar>
</template>
