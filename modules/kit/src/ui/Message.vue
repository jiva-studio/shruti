<template>
  <div class="message">
    <div class="content">
      <slot />
    </div>

    <IonButton
      class="close-button"
      shape="round"
      fill="clear"
      color="dark"
      @click.stop="$emit('close')"
    >
      <slot name="close-icon" />
    </IonButton>
  </div>
</template>

<script setup lang="ts">
/**
 * A dismissible inline message banner (warning palette by default) with a
 * trailing close button. Generic: the body is the default slot and the close
 * button's icon comes from the `close-icon` slot — kit imports no icon set.
 * Emits `close` when dismissed. Appearance is token-driven.
 */
import { IonButton } from "@ionic/vue"

defineEmits(["close"])
</script>

<style scoped>
.message {
  margin: 10px;
  padding: 8px 16px;
  background-color: var(--kit-message-bg, var(--ion-color-warning));
  color: var(--kit-message-fg, var(--ion-color-warning-contrast));
  border-radius: 8px;
  box-shadow: 0 0px 14px rgba(0, 0, 0, 0.1);
  display: flex;
  align-items: center;
}

.content {
  flex-grow: 1;
}

.close-button {
  transform: translateX(12px);
}
</style>
