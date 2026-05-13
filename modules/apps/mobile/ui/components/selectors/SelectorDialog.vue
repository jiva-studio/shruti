<template>
  <IonModal
    :is-open="open"
    :class="{ 'selector-dialog--sheet': sheet }"
    :breakpoints="sheet ? SHEET_BREAKPOINTS : undefined"
    :initial-breakpoint="sheet ? SHEET_INITIAL : undefined"
    :handle="sheet"
    @did-dismiss="onClose"
  >
    <Header>
      <IonToolbar>
        <IonTitle>{{ title }}</IonTitle>

        <IonButtons slot="end">
          <IonButton @click="onSelect">
            {{ $t("app.apply") }}
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
import { IonModal, IonContent, IonToolbar, IonButtons, IonButton, IonTitle } from "@ionic/vue"
import { Header } from "@ui/primitives/index.js"

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const SHEET_BREAKPOINTS = [0, 0.5, 0.9]
const SHEET_INITIAL = 0.9

withDefaults(
  defineProps<{
    open: boolean
    title: string
    /** Render as a draggable bottom sheet (matches the parent filters
     *  sheet) instead of a full-screen modal. */
    sheet?: boolean
  }>(),
  { sheet: false }
)

const emit = defineEmits<{
  close: []
  select: []
}>()

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onSelect() {
  emit("select")
  emit("close")
}

function onClose() {
  emit("close")
}
</script>

<style>
/* Kill the Material elevation under the toolbar when this dialog opens
   as a bottom sheet — the parent filters sheet doesn't have one, so the
   stacked sheet looked inconsistent. iOS hairline is already removed by
   the Header primitive's `ion-no-border`. */
.selector-dialog--sheet ion-header::after {
  display: none;
  background-image: none;
}
</style>
