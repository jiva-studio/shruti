<template>
  <IonItem
    lines="none"
    @click="onClick"
  >
    <!-- Item Icon -->
    <div
      slot="start"
      class="settings-item-icon"
    >
      <SendEmailIcon />
    </div>

    <!-- Text -->
    <IonLabel>
      <h2>{{ $t('settings.contacts.email.title') }}</h2>
      <p>{{ $t('settings.contacts.email.description') }}</p>
    </IonLabel>
  </IonItem>
</template>


<script setup lang="ts">
import { IonLabel, IonItem } from '@ionic/vue'
import SendEmailIcon from '../icons/SendEmailIcon.vue'

async function onClick() {
  window.open('mailto:contact@akdasa.studio', '_system')
}
</script>
