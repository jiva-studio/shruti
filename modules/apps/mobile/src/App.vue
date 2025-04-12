<template>
  <ion-app>
    <ion-router-outlet />
    <FloatingPlayer />
  </ion-app>
</template>

<script setup lang="ts">
import { IonApp, IonRouterOutlet } from '@ionic/vue'
import { FloatingPlayer, useSyncService } from '@/app'
import { onMounted } from 'vue'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const syncService = useSyncService()

onMounted(() => {
  syncService.sync()
})
</script>
