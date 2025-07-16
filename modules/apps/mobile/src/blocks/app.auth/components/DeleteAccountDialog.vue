<template>
  <IonContent :scroll-y="false">
    <PageSticker
      style="transform: translate(-50%, -35%);"
      :image="deleteAccountImg"
      :header="$t('settings.auth.deleteAccount.sure')"
      :message="$t('settings.auth.deleteAccount.description')"
    />
  </IonContent>

  <!-- Actions Section -->
  <IonFooter class="ion-no-border ion-padding actions">
    <IonCheckbox
      v-model="keepMyProgress"
      :helper-text="$t('settings.auth.deleteAccount.keepProgressDetails')"
      label-placement="end"
      color="danger"
      style="align-self: center; padding-bottom: 1rem;"
    >
      {{ $t('settings.auth.deleteAccount.keepProgress') }}
    </IonCheckbox>

    <HoldButton
      :text="$t('app.delete')"
      :confirmed-text="$t('app.deleted')"
      @confirm="onConfirm"
      @confirm-start="onConfirmStart"
      @confirming="onConfirming"
    />

    <IonNote class="ion-text-center">
      {{ $t('settings.auth.deleteAccount.pressAndHold') }}
    </IonNote>
  </IonFooter>

  <!-- Close Button -->
  <IonButton
    size="small"
    shape="round"
    class="close top-most"
    color="medium"
    @click="cancel"
  >
    <IonIcon
      slot="icon-only"
      class="top-most"
      :icon="close"
    />
  </IonButton>
</template>


<script setup lang="ts">
import { ref } from 'vue'
import { close } from 'ionicons/icons'
import { Haptics, ImpactStyle } from '@capacitor/haptics'
import { IonButton, IonIcon, IonNote, IonCheckbox, IonFooter, IonContent, modalController } from '@ionic/vue'
import { PageSticker, HoldButton } from '@blocks/app.ui.kit'
import deleteAccountImg from '../assets/delete.png'

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const keepMyProgress = ref(true)
const elapsedNotified = ref(0)

/* -------------------------------------------------------------------------- */
/*                                   Actions                                  */
/* -------------------------------------------------------------------------- */

function cancel() {
  modalController.dismiss(null, 'cancel')
}


/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onConfirmStart() {
  elapsedNotified.value = 0
}

function onConfirming(elapsed: number, holdTime: number) {
  if (elapsed > elapsedNotified.value) {
    Haptics.impact({ style: ImpactStyle.Light })
    elapsedNotified.value += Math.max(((holdTime - elapsed) / 5), 100)
  }
}

function onConfirm() {
  Haptics.impact({ style: ImpactStyle.Heavy })
  setTimeout(() => {
    modalController.dismiss({
      keepMyProgress: keepMyProgress.value
    }, 'confirm')
  }, 1000)
}
</script>

<style scoped>
.actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-bottom: var(--ion-safe-area-bottom, 0px);
}

.close {
  position: absolute;
  top: var(--ion-safe-area-top, 2rem);
  left: 10px;
}

.top-most {
  z-index: 99999999;
}
</style>