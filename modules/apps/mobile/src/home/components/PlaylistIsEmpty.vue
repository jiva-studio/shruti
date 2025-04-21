<template>
  <IonItem>
    {{ $t('home.playlistIsEmpty') }}
    <IonIcon
      slot="end"
      aria-hidden="true"
      color="primary"
      :icon="addCircle"
    />
  </IonItem>
</template>

<script setup lang="ts">
import { IonItem, IonIcon } from '@ionic/vue'
import { addCircle } from 'ionicons/icons'
</script>