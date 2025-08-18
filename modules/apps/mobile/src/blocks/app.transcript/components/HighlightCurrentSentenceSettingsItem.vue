<template>
  <IonItem lines="none">
    <!-- Item Icon -->
    <div
      slot="start"
      class="settings-item-icon"
    >
      <HighlightTextIcon />
    </div>
    
    <!-- Text -->
    <IonLabel class="ion-text-nowrap">
      <h2>{{ $t('settings.transcript.highlightCurrentSentence.title') }}</h2>
      <p>{{ $t('settings.transcript.highlightCurrentSentence.description') }}</p>
    </IonLabel>

    <!-- Toggle -->
    <IonToggle
      slot="end"
      v-model="config.highlightCurrentSentence.value"
      label-placement="start"
    />
  </IonItem>
</template>


<script setup lang="ts">
import { IonItem, IonLabel, IonToggle } from '@ionic/vue'
import { useConfig } from '@blocks/app.config'
import HighlightTextIcon from '../icons/HighlightTextIcon.vue'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const config = useConfig()
</script>