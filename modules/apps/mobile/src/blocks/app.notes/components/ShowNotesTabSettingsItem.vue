<template>
  <IonItem lines="none">
    <div
      slot="start"
      class="settings-item-icon"
    >
      <BookmarkIcon />
    </div>
    
    <IonLabel class="ion-text-nowrap">
      <h2>{{ $t('settings.notes.showTab.title') }}</h2>
      <p>{{ $t('settings.notes.showTab.description') }}</p>
    </IonLabel>

    <IonToggle
      slot="end"
      v-model="config.showNotesTab.value"
      label-placement="start"
    />
  </IonItem>
</template>


<script setup lang="ts">
import { IonItem, IonLabel, IonToggle } from '@ionic/vue'
import { useConfig } from '@blocks/app.config'
import BookmarkIcon from '../icons/BookmarkIcon.vue'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const config = useConfig()
</script>