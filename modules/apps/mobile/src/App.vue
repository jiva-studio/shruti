<template>
  <IonApp>
    <IonRouterOutlet />
    <Player />
    <Transcript />
    <NavigationBarHolder />
  </IonApp>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { IonApp, IonRouterOutlet } from '@ionic/vue'
import { NavigationBarHolder, useSyncService, useSafeOperation } from '@shruti/mobile/app'
import { Player, Transcript } from '@shruti/mobile/player'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const syncService = useSyncService()
const safeOperation = useSafeOperation()

/* -------------------------------------------------------------------------- */
/*                                    Hooks                                   */
/* -------------------------------------------------------------------------- */

onMounted(async () => {
  safeOperation.execute({
    operation: async () => { await syncService.sync() }
  })
})
</script>
