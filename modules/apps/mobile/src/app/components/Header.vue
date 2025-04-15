<template>
  <IonHeader
    :class="{
      'ion-no-border': isAndroid
    }"
  >
    <slot />
  </IonHeader>
</template>

<script setup lang="ts">
import { IonHeader, isPlatform } from '@ionic/vue'

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const isAndroid = isPlatform('android')
</script>