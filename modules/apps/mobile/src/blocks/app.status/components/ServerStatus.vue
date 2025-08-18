<template>
  <IonItem lines="none">
    <div
      slot="start"
      class="icon"
    >
      <div
        class="status-indicator"
        :class="status"
      >
        <div class="status-dot" />
        <div class="status-pulse" />
      </div>
    </div>
    <IonLabel>
      <h2>{{ description }}</h2>
      <p>{{ name }}</p>
    </IonLabel>
  </IonItem>
</template>

<script setup lang="ts">
import { IonItem, IonLabel } from '@ionic/vue'

defineProps<{
  name: string
  description: string
  status: 'online' | 'offline' | 'unknown'
}>()
</script>


<style scoped>
.status-indicator {
  position: relative;
  display: inline-block;
  width: 24px;
  height: 24px;
}

.status-dot {
  position: absolute;
  width: 12px;
  height: 12px;
  background-color: var(--ion-color-success, #00ff88);
  border-radius: 50%;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -30%);
  z-index: 2;
}

.status-pulse {
  position: absolute;
  width: 12px;
  height: 12px;
  background-color: var(--ion-color-success, #00ff88);
  border-radius: 50%;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -30%);
  animation: pulse 2s infinite;
  z-index: 1;
}

@keyframes pulse {
  0% {
    transform: translate(-50%, -30%) scale(1);
    opacity: 1;
  }
  100% {
    transform: translate(-50%, -30%) scale(3);
    opacity: 0;
  }
}
.offline .status-dot,
.offline .status-pulse {
    background-color: var(--ion-color-danger, #ff4444);
}
.offline .status-pulse {
    animation: none;
}

.unknown .status-dot,
.unknown .status-pulse {
    background-color: var(--ion-color-warning, #ffcc00);
}
.unknown .status-pulse {
    animation: none;
}

.icon {
  border-radius: 5px;
  padding: 5px 8px;
}
</style>