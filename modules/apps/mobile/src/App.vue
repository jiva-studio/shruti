<template>
  <ion-app>
    <ion-router-outlet />
    <FloatingPlayer />
  </ion-app>
</template>

<script setup lang="ts">
import { IonApp, IonRouterOutlet } from '@ionic/vue';
import { FloatingPlayer } from '@/app';
</script>
