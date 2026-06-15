<template>
  <IonHeader class="flat-header ion-no-border">
    <slot />
  </IonHeader>
</template>

<script setup lang="ts">
/**
 * IonHeader with the Material elevation/hairline stripped on every platform,
 * so routed pages read flat like the app's dialogs. Content via the default
 * slot (toolbar, back button, title).
 */
import { IonHeader } from "@ionic/vue"
</script>

<style scoped>
.flat-header,
.flat-header::after {
  box-shadow: none !important;
  background-image: none;
}

.flat-header::after {
  display: none;
}
</style>
