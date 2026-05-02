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
      <IonIcon slot="icon-only" :icon="closeCircleOutline" />
    </IonButton>
  </div>
</template>

<script setup lang="ts">
import { IonIcon, IonButton } from "@ionic/vue"
import { closeCircleOutline } from "ionicons/icons"

defineEmits(["close"])
</script>

<style scoped>
.message {
  margin: 10px;
  padding: 8px 16px;
  background-color: var(--ion-color-warning);
  color: var(--ion-color-warning-contrast);
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
