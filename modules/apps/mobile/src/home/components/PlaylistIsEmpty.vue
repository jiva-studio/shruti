<template>
  <IonItem>
    No tracks have been added to your playlist yet. Tap here to add some tracks.
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