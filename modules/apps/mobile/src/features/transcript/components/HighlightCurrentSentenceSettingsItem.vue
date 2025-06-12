<template>
  <IonItem lines="none">
    <div slot="start">
      🔦
    </div>
    
    <IonLabel class="ion-text-nowrap">
      <h2>{{ $t('settings.transcript.highlightCurrentSentence.title') }}</h2>
      <p>{{ $t('settings.transcript.highlightCurrentSentence.description') }}</p>
    </IonLabel>

    <IonToggle
      slot="end"
      v-model="config.highlightCurrentSentence.value"
      label-placement="start"
    />
  </IonItem>
</template>


<script setup lang="ts">
import { IonItem, IonLabel, IonToggle } from '@ionic/vue'
import { useConfig } from '@lectorium/mobile/features/app.config'
const config = useConfig()
</script>