<template>
  <IonItem
    lines="none"
    @click="onClicked"
  >
    <!-- Item Icon -->
    <div
      slot="start"
      class="settings-item-icon"
    >
      <SignInIcon />
    </div>

    <!-- User avatar -->
    <IonAvatar slot="end">
      <img
        :src="userImageUrl"
        @error="onAvatarLoadError"
      >
    </IonAvatar>
    
    <!-- Text -->
    <IonLabel
      v-if="!signedIn"
      class="ion-text-nowrap"
    >
      <h2>{{ $t('settings.auth.signIn.title') }}</h2>
      <p v-if="syncing">
        {{ $t('settings.auth.syncing') }}
      </p>
      <p v-else>
        {{ $t('settings.auth.signIn.description') }}
      </p>
    </IonLabel>
    <IonLabel v-else>
      <h2>{{ userName || $t('settings.auth.signedIn') }}</h2>
      <p v-if="syncing">
        {{ $t('settings.auth.syncing') }}
      </p>
      <p v-else>
        {{ 
          $tc('settings.auth.syncCompletedAt', { 
            count: lastSyncInfo.daysAgo, ...lastSyncInfo.time 
          }) 
        }}
      </p>
    </IonLabel>
  </IonItem>
</template>


<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { IonItem, IonLabel, IonAvatar } from '@ionic/vue'
import { useEventBus } from '@lectorium/mobile/core'
import { useRelativeDate } from '../composables/useRelativeDate'
import avatarPlaceHolder from '../assets/avatar-placeholder.png'
import SignInIcon from '../icons/SignInIcon.vue'

const eventBus = useEventBus()
const relativeDate = useRelativeDate()

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = defineProps<{
  userName: string,
  userImageUrl: string,
  signedIn: boolean,
  syncing: boolean,
  syncedAt: number
}>()


/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const userImageUrl = ref(props.userImageUrl || avatarPlaceHolder)
const lastSyncInfo = computed(() => relativeDate.parse(props.syncedAt))

/* -------------------------------------------------------------------------- */
/*                                    Hooks                                   */
/* -------------------------------------------------------------------------- */

watch(() => props.userImageUrl, (newUrl) => {
  userImageUrl.value = newUrl || 'avatar-placeholder.png'
})

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onClicked() {
  if (!props.signedIn) {
    eventBus.authSelectProvider.notify()
  } else {
    eventBus.authSelectAuthenticatedActions.notify()
  }
}

function onAvatarLoadError() {
  // If avatar image fails to load, use placeholder image.
  userImageUrl.value = avatarPlaceHolder
}
</script>