<script setup lang="ts">
import { IonButton, IonButtons, IonTitle, IonToolbar } from "@ionic/vue"
import { IconChevronLeft } from "@tabler/icons-vue"
import { Header } from "@ui/primitives/index.js"

defineProps<{
  title: string
  /** A sub-picker is on screen: show the back chevron, hide Reset. */
  drilled: boolean
  canReset?: boolean
}>()

const emit = defineEmits<{ back: []; reset: []; primary: [] }>()
</script>

<template>
  <Header class="flat-header">
    <IonToolbar>
      <IonButtons v-if="drilled" slot="start">
        <IonButton @click="emit('back')">
          <IconChevronLeft slot="icon-only" :size="22" />
        </IonButton>
      </IonButtons>
      <IonTitle>{{ title }}</IonTitle>
      <IonButtons slot="end">
        <IonButton v-if="!drilled" color="medium" :disabled="!canReset" @click="emit('reset')">
          {{ $t("search.filtersReset") }}
        </IonButton>
        <IonButton strong @click="emit('primary')">
          {{ $t("app.ok") }}
        </IonButton>
      </IonButtons>
    </IonToolbar>
  </Header>
</template>
