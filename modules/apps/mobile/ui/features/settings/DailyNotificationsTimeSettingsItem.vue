<template>
  <IonItem lines="none" button :detail="false" @click="onOpen">
    <IconChip slot="start">
      <ClockIcon />
    </IconChip>

    <IonLabel class="ion-text-nowrap">
      <h2>{{ $t("settings.notifications.daily.title") }}</h2>
      <p>{{ $t("settings.notifications.daily.description") }}</p>
    </IonLabel>

    <div slot="end" class="time-chip">{{ display }}</div>
  </IonItem>

  <!-- Bottom-anchored, content-sized sheet (slides up like an action sheet).
       Uses ion-picker directly — ion-datetime's wheel is fixed-width and
       lives in shadow DOM, so the columns can't be spread; ion-picker (what
       ion-datetime uses internally) lets us flex the two columns to full
       width. Cancel discards, Save commits the picked time. -->
  <IonModal :is-open="open" class="daily-time-modal" @did-dismiss="onCancel">
    <IonToolbar>
      <IonButtons slot="start">
        <IonButton @click="onCancel">{{ $t("app.cancel") }}</IonButton>
      </IonButtons>
      <IonButtons slot="end">
        <IonButton strong @click="onSave">{{ $t("app.save") }}</IonButton>
      </IonButtons>
    </IonToolbar>

    <IonPicker>
      <IonPickerColumn :value="draft[0]" @ion-change="onHour">
        <IonPickerColumnOption v-for="h in hours" :key="h" :value="h">
          {{ pad(h) }}
        </IonPickerColumnOption>
      </IonPickerColumn>
      <IonPickerColumn :value="draft[1]" @ion-change="onMinute">
        <IonPickerColumnOption v-for="m in minutes" :key="m" :value="m">
          {{ pad(m) }}
        </IonPickerColumnOption>
      </IonPickerColumn>
    </IonPicker>
  </IonModal>
</template>

<script setup lang="ts">
import { computed, ref } from "vue"
import {
  IonItem,
  IonLabel,
  IonModal,
  IonToolbar,
  IonButtons,
  IonButton,
  IonPicker,
  IonPickerColumn,
  IonPickerColumnOption,
} from "@ionic/vue"
import type { PickerColumnChangeEventDetail } from "@ionic/core"
import { ClockIcon } from "@ui/icons/index.js"
import { IconChip } from "@ui/primitives/index.js"

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const value = defineModel<[number, number] | undefined>({ default: undefined, required: true })
const open = ref(false)
// Picked-but-not-yet-saved time, seeded from the committed value on open so
// Cancel can discard it; Save commits.
const draft = ref<[number, number]>([9, 0])

const hours = Array.from({ length: 24 }, (_, i) => i)
const minutes = Array.from({ length: 12 }, (_, i) => i * 5)

function pad(n: number): string {
  return n.toString().padStart(2, "0")
}

const display = computed(() => {
  const [h, m] = value.value ?? [9, 0]
  return `${pad(h)} : ${pad(m)}`
})

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onOpen(): void {
  const [h, m] = value.value ?? [9, 0]
  draft.value = [h, m]
  open.value = true
}

function onHour(e: CustomEvent<PickerColumnChangeEventDetail>): void {
  const v = e.detail.value
  if (typeof v === "number") draft.value = [v, draft.value[1]]
}

function onMinute(e: CustomEvent<PickerColumnChangeEventDetail>): void {
  const v = e.detail.value
  if (typeof v === "number") draft.value = [draft.value[0], v]
}

function onSave(): void {
  value.value = [draft.value[0], draft.value[1]]
  open.value = false
}

function onCancel(): void {
  open.value = false
}
</script>

<style scoped>
.time-chip {
  background-color: var(--ion-color-light-shade);
  padding: 0.25rem 0.5rem;
  border-radius: 5px;
  font-size: 0.8rem;
}

ion-modal.daily-time-modal {
  --width: 100%;
  --max-width: 100%; /* beat Ionic's centered-dialog max-width on wide screens */
  --height: fit-content;
  --border-radius: 18px 18px 0 0;
  --box-shadow: 0 -6px 40px rgba(0, 0, 0, 0.28);
  align-items: flex-end;
}

ion-modal.daily-time-modal ion-toolbar {
  --background: var(--ion-background-color);
}

/* Spread the two wheel columns across the full width: hours on the left,
   minutes on the right. */
ion-modal.daily-time-modal ion-picker {
  width: 100%;
}
ion-modal.daily-time-modal ion-picker-column {
  flex: 1;
}
</style>
