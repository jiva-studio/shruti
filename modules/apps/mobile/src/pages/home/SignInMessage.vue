<template>
  <Message 
    @click="eventBus.authSelectProvider.notify()"
    @close="eventBus.tutorialCompleteStep.notify({ step: 'signInInvitation' })"
  >
    {{ $t('home.signInInvitation') }}
  </Message>
</template>


<script setup lang="ts">
import { useEventBus } from '@shruti/mobile/core'
import { Message } from '@blocks/app.ui.kit'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const eventBus = useEventBus()
</script>
