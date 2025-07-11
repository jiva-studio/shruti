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

    <div style="position: relative; overflow: visible;">
      <IonButton
        class="play"
        shape="round"
        color="primary"
        @click.stop="emit('play')"
      >
        <IonIcon
          slot="icon-only"
          :icon="playButtonIcon"
        />
      </IonButton>
      <div
        v-if="showProgress"
        class="progress"
      >
        <RadialProgress
          :stroke-width="4"
          :inner-stroke-width="4"
          :diameter="playButtonSize"
          :completed-steps="position"
          :total-steps="duration"
          :animate-speed="750"
          start-color="rgba(255, 255, 255, .65)"
          stop-color="rgba(255, 255, 255, .65)"
          inner-stroke-color="rgba(255, 255, 255, 0)"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Capacitor } from '@capacitor/core'
import { IonButton, IonIcon, IonLabel } from '@ionic/vue'
import { play, pause } from 'ionicons/icons'
import { computed, ref, toRefs } from 'vue'
import RadialProgress from 'vue3-radial-progress'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = defineProps<{
  playing: boolean
  author: string
  title: string
  duration: number
  position: number
  showProgress: boolean
}>()

const emit = defineEmits<{
  play: []
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const { playing } = toRefs(props)
const playButtonSize = ref(Capacitor.getPlatform() === 'android' ? 48 : 44)

const playButtonIcon = computed(() => {
  return playing.value ? pause : play
})
</script>

<style scoped>
.player {
  background-color: var(--ion-color-primary-tint);
  color: var(--ion-color-primary-contrast);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: .5rem;
  padding-left: 1rem;
}

.info {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  font-size: .9rem;
  overflow: hidden;
  gap: .15rem;
}

.author {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  opacity: .8;
}

.title {
  font-weight: bold;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.play {
  --box-shadow: none;
}

.progress {
  position: absolute; 
  top: 50%; 
  left: 50%; 
  transform: translate(-50%, -50%);
  overflow: visible;
  pointer-events: none;
}
</style>