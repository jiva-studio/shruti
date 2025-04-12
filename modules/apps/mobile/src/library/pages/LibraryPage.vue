<template>
  <IonPage>
    <IonContent :fullscreen="true">
      <IonSearchbar placeholder="Custom Placeholder" />
      <TracksFilterBar v-model="filters" />
      <TracksSearchResults
        :filters="filters"
      />
    </IonContent>
  </IonPage>
</template>

<script setup lang="ts">
import { IonPage, IonContent, IonSearchbar } from '@ionic/vue'
import { TracksFilterBar, TracksFilterValue, TracksSearchResults } from '@/library'
import { ref } from 'vue'

const filters = ref<TracksFilterValue>({
  ids: [],
  authors: [],
  sources: [],
  locations: [],
  languages: [],
  duration: { min: 0, max: Number.MAX_SAFE_INTEGER },
  dates: { from: '', to: '' },
})
</script>
