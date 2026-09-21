<script setup lang="ts">
import { IonItem, IonLabel, IonList, IonListHeader } from "@ionic/vue"
import { IconChip } from "@ui/primitives/index.js"
import { helpManifest, type HelpPageId } from "./pages/manifest.js"

const emit = defineEmits<{
  select: [HelpPageId]
}>()
</script>

<template>
  <IonList>
    <template v-for="category in helpManifest" :key="category.id">
      <IonListHeader>
        <IonLabel>{{ $t(`help.categories.${category.id}`) }}</IonLabel>
      </IonListHeader>

      <IonItem
        v-for="page in category.pages"
        :key="page.id"
        button
        :detail="true"
        lines="none"
        @click="emit('select', page.id)"
      >
        <IconChip slot="start">
          <component :is="page.icon" />
        </IconChip>
        <IonLabel class="ion-text-wrap">
          <h2>{{ $t(`help.pages.${page.id}.title`) }}</h2>
          <p>{{ $t(`help.pages.${page.id}.summary`) }}</p>
        </IonLabel>
      </IonItem>
    </template>
  </IonList>
</template>
