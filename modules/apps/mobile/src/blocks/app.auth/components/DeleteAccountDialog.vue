<template>
  <IonContent
    class="ion-padding"
  >
    <PageSticker 
      :image="deleteAccountImg"
      :header="$t('settings.auth.deleteAccount.sure')"
      :message="$t('settings.auth.deleteAccount.description')"
    />
  </IonContent>

  <IonFooter class="ion-no-border ion-padding">
    <IonToolbar>
      <div class="actions">
        <IonCheckbox
          v-if="false"
          v-model="wipeMyProgressAlso"
          label-placement="end"
          color="danger"
        >
          {{ $t('settings.auth.deleteAccount.myProgressAlso') }}
        </IonCheckbox>
        <IonButton
          fill="solid"
          expand="block"
          color="danger"
          @click="confirm"
        >
          {{ $t('app.delete') }}
        </IonButton>
        <IonButton
          fill="clear"
          expand="block"
          color="medium"
          @click="cancel"
        > 
          {{ $t('app.cancel') }}
        </IonButton>
      </div>
    </IonToolbar>
  </IonFooter>
</template>


<script setup lang="ts">
import { ref } from 'vue'
import { IonButton, IonCheckbox, IonFooter, IonToolbar, IonContent, modalController } from '@ionic/vue'
import deleteAccountImg from '../assets/delete.png'
import { PageSticker } from '@blocks/app.ui.kit'

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const wipeMyProgressAlso = ref(false)

/* -------------------------------------------------------------------------- */
/*                                   Actions                                  */
/* -------------------------------------------------------------------------- */

function cancel() {
  modalController.dismiss(null, 'cancel')
}

function confirm() {
  modalController.dismiss({
    wipeMyProgressAlso: wipeMyProgressAlso.value
  }, 'confirm')
}
</script>

<style scoped>
.actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
</style>