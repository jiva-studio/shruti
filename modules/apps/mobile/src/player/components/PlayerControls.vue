<template>
  <div class="floatingPlayer">
    <div class="info">
      <IonLabel class="author">
        A.C. Bhaktivedanta Swami Prabhupada
      </IonLabel>
      <IonLabel class="title">
        Krishna is the Supreme Personality of Godhead
      </IonLabel>
    </div>

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
  </div>
</template>

<script setup lang="ts">
import { IonButton, IonIcon, IonLabel } from '@ionic/vue'
import { play, pause } from 'ionicons/icons'
import { computed, toRefs } from 'vue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = defineProps<{
  playing: boolean
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
}

.author {
  font-weight: bold;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.title {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.play {
  --box-shadow: none;
}
</style>