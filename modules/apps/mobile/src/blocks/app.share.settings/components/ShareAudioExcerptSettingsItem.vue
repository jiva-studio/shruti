<template>
  <IonItem lines="none">
    <div slot="start">
      🎙️
    </div>
    
    <IonLabel class="ion-text-nowrap">
      <h2>{{ $t('settings.share.audioExcerpt.title') }}</h2>
      <p>{{ $t('settings.share.audioExcerpt.description') }}</p>
    </IonLabel>

    <IonToggle
      slot="end"
      v-model="value"
      label-placement="start"
    />
  </IonItem>
</template>


<script setup lang="ts">
import { IonItem, IonLabel, IonToggle } from '@ionic/vue'

const value = defineModel<boolean>('value', { default: false, required: true })
</script>