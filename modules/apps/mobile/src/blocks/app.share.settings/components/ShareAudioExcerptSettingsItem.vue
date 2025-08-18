<template>
  <IonItem lines="none">
    <div
      slot="start"
      class="settings-item-icon"
    >
      <ShareAudioFragmentIcon />
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
import ShareAudioFragmentIcon from '../icons/ShareAudioFragmentIcon.vue'

const value = defineModel<boolean>('value', { default: false, required: true })
</script>