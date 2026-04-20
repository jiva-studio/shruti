<template>
  <Teleport to="body">
    <PlayerControls
      :playing="playing"
      :title="title"
      :author="author"
      :duration="duration"
      :position="position"
      :show-progress="showProgress"
      :play-button-size="playButtonSize"
      :class="{
        player: true,
        floating: !sticked,
        stick: sticked,
        hidden: hidden,
        pulsing: pulsing,
      }"
      @play="emit('playClicked')"
      @click="emit('click')"
    />
  </Teleport>
</template>

<script setup lang="ts">
import PlayerControls from "./PlayerControls.vue"

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

withDefaults(
  defineProps<{
    playing: boolean
    title: string
    author: string
    hidden: boolean
    duration: number
    position: number
    showProgress: boolean
    sticked: boolean
    pulsing: boolean
    /** Forwarded to PlayerControls; default matches iOS tap-target sizing. */
    playButtonSize?: number
  }>(),
  { playButtonSize: 44 }
)

const emit = defineEmits<{
  playClicked: []
  click: []
}>()
</script>

<style scoped>
.player {
  z-index: 10000;
  position: fixed;
  transition: all 0.5s ease-in-out;
  box-shadow: 0px 0px 15px rgba(0, 0, 0, 0.25);
}

.floating {
  bottom: calc(56px + var(--ion-safe-area-bottom, 0px));
  height: 58px;
  left: 16px;
  right: 16px;
  border-radius: 10px;
}

.stick {
  /* Minimum 12px floor so the content isn't flush to the bottom on
     web or on devices without a safe-area inset; respects the inset
     when it exceeds the floor (notched mobiles). */
  height: calc(56px + max(var(--ion-safe-area-bottom, 0px), 12px));
  padding-bottom: max(var(--ion-safe-area-bottom, 0px), 12px);

  bottom: 0;
  left: 0;
  right: 0;
  border-top-left-radius: 5px;
  border-top-right-radius: 5px;
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
}

.hidden {
  opacity: 0;
  bottom: 0;
  pointer-events: none;
}

.pulsing {
  animation: inviteClick 3s ease-in-out infinite;
}

@keyframes inviteClick {
  0%,
  100% {
    transform: scale(1);
  }
  10% {
    transform: scale(0.98);
  }
  20% {
    transform: scale(1.01);
  }
  30% {
    transform: scale(0.99);
  }
  40% {
    transform: scale(1);
  }
}
</style>
