<template>
  <div
    class="root"
    :class="{ 'no-messages': !messageToShow}"
  >
    <TransitionGroup name="fade">
      <SignInMessage
        v-if="messageToShow === 'signin'"
        key="signin"
      />
      <NotificationsMessage
        v-if="messageToShow === 'notifications'"
        key="notifications"
      />
    </TransitionGroup>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useConfig } from '@blocks/app.config'
import { usePlaylistStore } from '@blocks/app.playlist'
import SignInMessage from './SignInMessage.vue'
import NotificationsMessage from './NotificationsMessage.vue'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const config = useConfig()
const playlist = usePlaylistStore()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const messageToShow = computed(() => getMessageToShow())

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

function getMessageToShow() {
  if (
    playlist.items.length > 0 && 
    config.notificationsEnabled.value === undefined
  ) { 
    return 'notifications' 
  }
  
  if (
    !config.userId.value && 
    playlist.items.some(x => x.progress && (x.progress >= 10)) && 
    !config.tutorialStepsCompleted.value.includes('signInInvitation')
  ) {
    console.log(playlist.items.map(x => x.progress))
    return 'signin'
  } 
}
</script>

<style scoped>
/* 1. declare transition */
.fade-move,
.fade-enter-active,
.fade-leave-active {
  transition: all 0.5s ease-out;
}

/* 2. declare enter from and leave to state */
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translate(0px, -150px);
}

/* 3. ensure leaving items are taken out of layout flow so that moving
      animations can be calculated correctly. */
.fade-leave-active {
  position: absolute;
  left: 0px;
  right: 0px;
}

.root {
  width: 100%;
  height: 70px;
  transition: all 0.5s ease-out;
}

.no-messages {
  height: 0px;
}
</style>