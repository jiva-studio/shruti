<template>
  <IonItem lines="none">
    <div slot="start">
      📜
    </div>
    
    <IonLabel class="ion-text-nowrap">
      <h2>{{ $t('settings.transcript.showAutomatically.title') }}</h2>
      <p>{{ $t('settings.transcript.showAutomatically.description') }}</p>
    </IonLabel>

    <IonToggle
      slot="end"
      v-model="config.openTranscriptAutomatically.value"
      label-placement="start"
    />
  </IonItem>
</template>


<script setup lang="ts">
import { IonItem, IonLabel, IonToggle } from '@ionic/vue'
import { useConfig } from '@blocks/app.config'
const config = useConfig()
</script>