<template>
  <div class="floatingPlayer">
    <div class="info">
      <IonLabel class="title">
        {{ title }}
      </IonLabel>
      <IonLabel class="author">
        {{ author }}
      </IonLabel>
    </div>

    <IonButton
      class="play"
      shape="round"
      color="primary"
      @click.stop="emit('play')"
    >
      <!-- <RadialProgress
        style="position: absolute;"
        :stroke-width="3"
        :inner-stroke-width="3"
        :diameter="44"
        :completed-steps="position"
        :total-steps="duration"
        :animate-speed="750"
        start-color="rgba(255, 255, 255, .5)"
        stop-color="rgba(255, 255, 255, .5)"
        inner-stroke-color="rgba(255, 255, 255, 0)"
      /> -->
      <IonIcon
        slot="icon-only"
        :icon="playButtonIcon"
      />
    </IonButton>
  </div>
</template>

<script setup lang="ts">
import { IonButton, IonIcon, IonLabel } from '@ionic/vue'
import { play, pause } from 'ionicons/icons'
import { computed, toRefs } from 'vue'
// import RadialProgress from 'vue3-radial-progress'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = defineProps<{
  playing: boolean
  author: string
  title: string
  duration: number
  position: number
}>()

const emit = defineEmits<{
  play: []
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const { playing } = toRefs(props)

const playButtonIcon = computed(() => {
  return playing.value ? pause : play
})
</script>

<style scoped>
.floatingPlayer {
  background-color: var(--ion-color-primary-tint);
  color: var(--ion-color-primary-contrast);
  box-shadow: 0px 0px 15px rgba(0, 0, 0, .2);
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
</style>