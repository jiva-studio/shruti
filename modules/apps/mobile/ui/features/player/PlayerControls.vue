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

<script setup lang="ts">
import { IonLabel } from "@ionic/vue"

defineProps<{
  author: string
  title: string
}>()
</script>

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

.author {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  opacity: 0.8;
}

.title {
  font-weight: bold;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
</style>
