<template>
  <IonModal
    :is-open="open"
    @did-dismiss="open = false"
  >
    <IonContent
      :fullscreen="true"
      class="ion-padding"
    >
      <slot /> 
    </IonContent>
  </IonModal>
</template>

<script setup lang="ts">
import { IonModal, IonContent } from '@ionic/vue'
const open = defineModel<boolean>('open')
</script>


<style scoped>
ion-modal ion-content {
  --background: #1D263B;
}

ion-modal ion-toolbar {
  --background: #1D263B;
}
</style>