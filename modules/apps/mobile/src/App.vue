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
import { NavigationBarHolder, useSyncService, useSafeOperation } from '@lectorium/mobile/app'
import { Player, Transcript } from '@lectorium/mobile/player'

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
