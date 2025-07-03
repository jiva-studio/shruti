<template>
  <IonItem
    lines="none"
    @click="onClicked"
  >
    <!-- User avatar -->
    <div
      slot="start"
    >
      🔑
    </div>
    <IonAvatar
      v-if="config.userAvatarUrl.value"
      slot="end"
    >
      <img
        :src="config.userAvatarUrl.value"
        @error="onAvatarLoadError"
      >
    </IonAvatar>
    
    <!-- Text -->
    <IonLabel
      v-if="!config.userEmail.value"
      class="ion-text-nowrap"
    >
      <h2>{{ $t('settings.auth.signIn.title') }}</h2>
      <p>{{ $t('settings.auth.signIn.description') }}</p>
    </IonLabel>
    <IonLabel v-else>
      <h2>{{ config.userName.value || $t('settings.auth.signedIn') }}</h2>
      <p v-if="syncStore.isSyncing">
        {{ $t('settings.auth.syncing') }}
      </p>
      <p v-else>
        {{ $t('settings.auth.syncCompleted') }}
      </p>
    </IonLabel>
  </IonItem>

  <IonActionSheet
    :header="isAuthenticated ? $t('settings.auth.actions') : $t('settings.auth.signIn.subtitle')"
    :is-open="isActionSheetOpen"
    :buttons="config.userEmail.value ? signedInUserActionButtons : actionSheetButtons"
    @did-dismiss="onActionClicked"
  />
</template>


<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { IonActionSheet, IonItem, IonLabel, IonAvatar } from '@ionic/vue'
import { useConfig } from '@lectorium/mobile/features/app.config'
import { Capacitor } from '@capacitor/core'
import { Events } from '@lectorium/mobile/events'
import { useSyncStore } from '@lectorium/mobile/features/app.services.sync'

const { t } = useI18n()
const config = useConfig()
const syncStore = useSyncStore()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const isActionSheetOpen = ref(false) 
const isAuthenticated = computed(() => config.userEmail.value !== '')
const googleAction = { text: 'Google',  data: { action: 'google' } }
const appleAction  = { text: 'Apple',   data: { action: 'apple' } }
const logoutAction = { text: t('settings.auth.signOut'), data: { action: 'logout' } }
const cancelAction = { text: t('app.cancel'),  role: 'cancel', data: { action: 'cancel' } }

// TODO: logoutAction and cancelAction don't automatically translate because they are not reactive. 
const actionSheetButtons = 
  Capacitor.getPlatform() === 'ios'     ? [appleAction, googleAction, cancelAction] :
  Capacitor.getPlatform() === 'android' ? [googleAction, cancelAction] : []
const signedInUserActionButtons = [logoutAction, cancelAction]

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onClicked() {
  if (!isAuthenticated.value && Capacitor.getPlatform() === 'android') {
    // On android there is onlu Google sign-in available, so where is no
    // need to show action sheet with only one option.
    Events.authenticationRequestedEvent.notify({ provider: 'google' })
  } else {
    isActionSheetOpen.value = true
  }
}

async function onActionClicked(
  event: CustomEvent
) {
  const action = event.detail?.data?.action
  if (['google', 'apple'].includes(action)) { 
    Events.authenticationRequestedEvent.notify({ provider: action })
  } else if (action === 'logout') {
    Events.logOutRequestedEvent.notify()
  }
  isActionSheetOpen.value = false
}

function onAvatarLoadError() {
 // If avatar image fails to load, use placeholder image.
  config.userAvatarUrl.value = Capacitor.convertFileSrc('avatar-placeholder.png')
}
</script>