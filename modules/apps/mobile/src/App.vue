<template>
  <IonApp>
    <IonRouterOutlet />
    <Player />
    <NavigationBarHolder />
  </IonApp>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { IonApp, IonRouterOutlet } from '@ionic/vue'
import { NavigationBarHolder, useSyncService } from '@/app'
import { Player, useSyncAudioPlayerPluginState, useSetPlayerControlsInfo } from '@/player'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const syncService = useSyncService()

/* -------------------------------------------------------------------------- */
/*                                    Hooks                                   */
/* -------------------------------------------------------------------------- */

onMounted(async () => {
  syncService.sync()

  // Player //

  useSyncAudioPlayerPluginState()
  useSetPlayerControlsInfo()
})
</script>
