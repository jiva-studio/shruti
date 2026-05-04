<template>
  <div class="player">
    <div class="info">
      <IonLabel class="title">
        {{ title }}
      </IonLabel>
      <IonLabel class="author">
        {{ author }}
      </IonLabel>
    </div>
    <!-- Reserved slot under which the FloatingPlayer's shared Play
         button sits when this page is the active one. The slot keeps
         the title/author flex from spilling under Play. -->
    <div class="play-slot" :style="{ width: playButtonSize + 'px' }" />
  </div>
</template>

<script setup lang="ts">
import { IonLabel } from "@ionic/vue"

withDefaults(
  defineProps<{
    author: string
    title: string
    /** Width (px) reserved on the right for the shared Play overlay. */
    playButtonSize?: number
  }>(),
  { playButtonSize: 44 }
)
</script>

<style scoped>
.player {
  background-color: var(--ion-color-primary-tint);
  color: var(--ion-color-primary-contrast);
  display: flex;
  align-items: center;
  height: 100%;
  padding: 0.5rem;
  padding-left: 1rem;
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

.play-slot {
  flex-shrink: 0;
  height: 100%;
}
</style>
