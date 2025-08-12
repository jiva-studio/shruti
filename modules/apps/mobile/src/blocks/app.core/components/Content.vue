<template>
  <IonContent
    class="ion-padding"
    :scroll-events="true"
    @ion-scroll="onScroll"
  >
    <div class="safe-padding">
      <slot />
    </div>
  </IonContent>
</template>


<script setup lang="ts">
import { provide, ref } from 'vue'
import { IonContent } from '@ionic/vue'

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const scrollTop = ref(0)

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

provide('scrollTop', scrollTop)

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onScroll(event: any) {
  scrollTop.value = event.detail.scrollTop
}
</script>


<style scoped>
.safe-padding {
  padding-top: var(--ion-safe-area-top, 2rem);
  padding-bottom: var(--ion-safe-area-bottom, 2rem);
}
</style>
