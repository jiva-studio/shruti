<template>
  <IonItem lines="none">
    <div
      slot="start"
      class="settings-item-icon"
    >
      <PlayIcon />
    </div>
    
    <IonLabel class="ion-text-nowrap">
      <h2>{{ $t('settings.player.showProgress.title') }}</h2>
      <p>{{ $t('settings.player.showProgress.description') }}</p>
    </IonLabel>

    <IonToggle
      slot="end"
      v-model="config.showPlayerProgress.value"
      label-placement="start"
    />
  </IonItem>
</template>


<script setup lang="ts">
import { IonItem, IonLabel, IonToggle } from '@ionic/vue'
import { useConfig } from '@blocks/app.config'
import PlayIcon from '../icons/PlayIcon.vue'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const config = useConfig()
</script>