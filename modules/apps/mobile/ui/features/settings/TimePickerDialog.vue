<template>
  <IonModal
    :is-open="isOpen"
    :initial-breakpoint="1"
    :breakpoints="[0, 1]"
    :handle="true"
    @did-dismiss="onCancel"
  >
    <IonToolbar>
      <IonButtons slot="start">
        <IonButton
          shape="round"
          size="small"
          @click="onCancel"
        >
          {{ $t("app.cancel") }}
        </IonButton>
      </IonButtons>
      <IonButtons slot="end">
        <IonButton
          shape="round"
          size="small"
          @click="onSaveClicked"
        >
          {{ $t("app.save") }}
        </IonButton>
      </IonButtons>
    </IonToolbar>

    <TimePicker
      :hours="hours ?? 9"
      :minutes="minutes ?? 0"
      @change="onChange"
    />
  </IonModal>
</template>

<script lang="ts" setup>
import { ref } from 'vue'
import { IonModal, IonButtons, IonButton, IonToolbar } from '@ionic/vue'
import TimePicker from './TimePicker.vue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

defineProps<{
  hours?: number,
  minutes?: number,
}>()

const emit = defineEmits<{
  select: [number, number]
}>()

const isOpen = defineModel<boolean>('open', { required: true, default: false })

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const value = ref<[number, number]>([9, 0])

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onChange(hours: number, minutes: number) {
  value.value = [hours, minutes]
}

function onCancel() {
  isOpen.value = false
}

function onSaveClicked() {
  isOpen.value = false
  emit('select', ...value.value)
}
</script>

<style scoped>
.block {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

ion-modal {
  --height: auto;
}
</style>
