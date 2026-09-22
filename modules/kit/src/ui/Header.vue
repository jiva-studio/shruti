<template>
  <IonHeader
    :class="{
      'ion-no-border': isAndroid,
    }"
  >
    <slot />
  </IonHeader>
</template>

<script setup lang="ts">
/**
 * Thin wrapper over `IonHeader` that drops the bottom border on Android (where
 * the platform convention is a borderless, flat app bar). Content via the
 * default slot — fully generic, no i18n/router.
 */
import { IonHeader, isPlatform } from "@ionic/vue"

const isAndroid = isPlatform("android")
</script>
