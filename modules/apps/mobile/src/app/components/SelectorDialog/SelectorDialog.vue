<template>
  <IonModal
    :is-open="open"
    @did-dismiss="onClose"
  >
    <Header>
      <IonToolbar>
        <IonTitle>{{ title }}</IonTitle>

        <IonButtons slot="end">
          <IonButton
            @click="onSelect"
          >
            {{ $t('app.apply') }}
          </IonButton>
        </IonButtons>
      </IonToolbar>
    </Header>

    <IonContent>
      <slot />
    </IonContent>
  </IonModal>
</template>


<script setup lang="ts">
import { IonModal, IonContent, IonToolbar, IonButtons, IonButton, IonTitle } from '@ionic/vue'
import { Header } from '@lectorium/mobile/app'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

defineProps<{
  open: boolean
  title: string
}>()

const emit = defineEmits<{
  close: [],
  select: []
}>()

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onSelect() {
  emit('select')
  emit('close')
}

function onClose() {
  emit('close')
}
</script>