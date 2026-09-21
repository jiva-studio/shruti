<script setup lang="ts">
import { IonModal, IonContent, IonToolbar, IonButtons, IonButton, IonTitle } from "@ionic/vue"
import { Header } from "@ui/primitives/index.js"

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
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const SHEET_BREAKPOINTS = [0, 0.5, 0.9]
const SHEET_INITIAL = 0.9

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

<template>
  <IonModal
    :is-open="open"
    :class="['selector-dialog', { 'selector-dialog--sheet': sheet }]"
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

<style>
/* Kill the Material elevation under the toolbar so every dialog reads
   as a flat sheet. iOS hairline is already removed by the Header
   primitive's `ion-no-border`. */
.selector-dialog ion-header,
.selector-dialog ion-header::after {
  box-shadow: none !important;
  background-image: none;
}
.selector-dialog ion-header::after {
  display: none;
}
</style>
