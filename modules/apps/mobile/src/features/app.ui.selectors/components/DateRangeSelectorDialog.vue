<template>
  <SelectorDialog
    :open="open"
    :title="title"
    @select="onSelect"
    @close="onClose"
  >
    <IonItem>
      <IonLabel>{{ $t('app.from') }}</IonLabel>
      <IonButton
        id="start-date-button"
        fill="clear"
      >
        {{ value.from ? formatDate(value.from) : $t('app.select') }}
      </IonButton>
    </IonItem>

    <IonItem>
      <IonLabel>{{ $t('app.to') }}</IonLabel>
      <IonButton
        id="end-date-button"
        fill="clear"
      >
        {{ value.to ? formatDate(value.to) : $t('app.select') }}
      </IonButton>
    </IonItem>

    <IonPopover trigger="start-date-button">
      <IonDatetime
        presentation="month-year"
        :value="value.from"
        @ion-change="v => onStartDateChanged(v.detail.value)"
      />
    </IonPopover>

    <IonPopover trigger="end-date-button">
      <IonDatetime
        presentation="month-year"
        :value="value.to"
        @ion-change="v => onEndDateChanged(v.detail.value)"
      />
    </IonPopover>
  </SelectorDialog>
</template>


<script setup lang="ts">
import { ref, watch } from 'vue'
import { IonButton, IonDatetime, IonPopover, IonItem, IonLabel } from '@ionic/vue'
import SelectorDialog from './SelectorDialog.vue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

export type DateRange = { from: string, to: string }
const props = defineProps<{
  open: boolean,
  title: string,
  value: DateRange|undefined
}>()

const emit = defineEmits<{
  close: [],
  select: [value: DateRange]
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const value = ref<DateRange>({ 
  from: props.value?.from || '', 
  to: props.value?.to || ''
})

/* -------------------------------------------------------------------------- */
/*                                    Hooks                                   */
/* -------------------------------------------------------------------------- */

watch(() => props.value, (newValue) => { 
  if (!newValue) {
    value.value = { from: '', to: '' }
    return
  }
  value.value = newValue 
})

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onStartDateChanged(v: string | string[] | undefined | null) {
  if (typeof v !== 'string') return
  value.value.from = getFirstDayOfMonth(new Date(v))
}

function onEndDateChanged(v: string | string[] | undefined | null) {
  if (typeof v !== 'string') return
  value.value.to = getLastDayOfMonth(new Date(v))
}

function onClose() {
  emit('close')
}

function onSelect() {
  emit('select', value.value)
}

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

function getFirstDayOfMonth(date: Date) {
  return `${date.getFullYear()}-${(date.getMonth()+1).toString().padStart(2, '0')}-01`
}

function getLastDayOfMonth(date: Date) {
  const newDate = new Date(date.getFullYear(), date.getMonth() + 1, 0, 0, 0, 0, 0)
  return `${newDate.getFullYear()}-${(newDate.getMonth()+1).toString().padStart(2, '0')}-${newDate.getDate()}`
}

function formatDate(date: string) {
  // TODO: Use app locale
  return new Date(date).toLocaleDateString('ru-RU', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}
</script>