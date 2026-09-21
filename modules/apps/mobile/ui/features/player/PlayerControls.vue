<script setup lang="ts">
import { IonLabel } from "@ionic/vue"

defineProps<{
  author: string
  title: string
}>()
</script>

<template>
  <div class="player-controls">
    <div class="info">
      <IonLabel class="title">
        {{ title }}
      </IonLabel>
      <IonLabel class="author">
        {{ author }}
      </IonLabel>
    </div>
  </div>
</template>

<style scoped>
.player-controls {
  display: flex;
  align-items: center;
  height: 100%;
  width: 100%;
  padding-left: 4px;
}

.info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  font-size: 0.9rem;
  overflow: hidden;
  gap: 0.15rem;
}

/* IonLabel sets its own color from --ion-text-color, which is tuned for the
   page background, not the player's saffron surface. Pin both lines to the
   player surface's contrast token so they stay readable in both themes. */
.author {
  color: var(--ion-color-primary-contrast);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  opacity: 0.8;
}

.title {
  color: var(--ion-color-primary-contrast);
  font-weight: bold;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
</style>
