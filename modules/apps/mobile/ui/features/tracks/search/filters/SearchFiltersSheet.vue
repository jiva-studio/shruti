<template>
  <IonModal
    :is-open="open"
    :breakpoints="[0, 0.5, 0.9]"
    :initial-breakpoint="0.9"
    handle
    @did-dismiss="onDismiss"
  >
    <IonHeader>
      <IonToolbar>
        <IonTitle>{{ $t("search.filtersSheetTitle") }}</IonTitle>
        <IonButtons slot="end">
          <IonButton :disabled="!canReset" @click="onReset">
            {{ $t("search.filtersReset") }}
          </IonButton>
        </IonButtons>
      </IonToolbar>
    </IonHeader>

    <IonContent class="ion-padding-bottom">
      <IonList lines="full" class="ion-no-padding">
        <template v-for="section in sections" :key="section.key">
          <!-- Multi-select rows open the existing list dialog. -->
          <IonItem
            v-if="section.kind === 'multi'"
            button
            :detail="true"
            @click="openMulti(section.key)"
          >
            <component :is="section.icon" slot="start" class="section-icon" />
            <IonLabel>{{ section.title }}</IonLabel>
            <span v-if="multiCount(section.key) > 0" slot="end" class="count-pill">
              {{ multiCount(section.key) }}
            </span>
          </IonItem>

          <!-- Single-select sections render an inline segment. -->
          <IonItem v-else lines="full" class="segment-row">
            <div class="segment-row-inner">
              <div class="segment-label">
                <component :is="section.icon" class="section-icon" />
                <IonLabel>{{ section.title }}</IonLabel>
              </div>
              <IonSegment
                scrollable
                :value="singleValue(section.key)"
                @ion-change="(e) => onSingleChange(section.key, e.detail.value)"
              >
                <IonSegmentButton v-for="item in section.items" :key="item.id" :value="item.id">
                  <IonLabel>{{ item.title }}</IonLabel>
                </IonSegmentButton>
              </IonSegment>
            </div>
          </IonItem>
        </template>
      </IonList>
    </IonContent>
  </IonModal>

  <!-- Stacked above the sheet. Only one is open at a time. -->
  <ListItemsSelectorDialog
    v-if="activeMultiSection"
    :title="activeMultiSection.title"
    :open="!!activeMultiSection"
    :items="activeMultiSection.items"
    :selected="multiSelected(activeMultiSection.key)"
    @close="onMultiClose"
    @select="onMultiSelect"
  />
</template>

<script setup lang="ts">
import { computed, ref } from "vue"
import {
  IonModal,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonButtons,
  IonButton,
  IonContent,
  IonList,
  IonItem,
  IonLabel,
  IonSegment,
  IonSegmentButton,
} from "@ionic/vue"
import { ListItemsSelectorDialog } from "@ui/components/selectors/index.js"
import type {
  FiltersModel,
  MultiSectionDef,
  MultiSectionKey,
  SearchFilterSectionDef,
  SingleSectionKey,
} from "./types.js"

const props = defineProps<{
  open: boolean
  sections: readonly SearchFilterSectionDef[]
  canReset?: boolean
}>()

const filters = defineModel<FiltersModel>("filters", { required: true })

const emit = defineEmits<{
  "update:open": [open: boolean]
  reset: []
}>()

const activeMultiKey = ref<MultiSectionKey | null>(null)

const activeMultiSection = computed<MultiSectionDef | null>(() => {
  const key = activeMultiKey.value
  if (!key) return null
  const section = props.sections.find((s) => s.key === key)
  return section && section.kind === "multi" ? section : null
})

function multiSelected(key: MultiSectionKey): string[] {
  return (filters.value[key] as string[] | undefined) ?? []
}

function multiCount(key: MultiSectionKey): number {
  return multiSelected(key).length
}

function singleValue(key: SingleSectionKey): string | undefined {
  return filters.value[key] as string | undefined
}

function openMulti(key: MultiSectionKey): void {
  activeMultiKey.value = key
}

function onMultiClose(): void {
  activeMultiKey.value = null
}

function onMultiSelect(ids: string[]): void {
  const key = activeMultiKey.value
  if (!key) return
  filters.value = { ...filters.value, [key]: ids }
  activeMultiKey.value = null
}

function onSingleChange(key: SingleSectionKey, value: string | number | undefined): void {
  const next = value === undefined || value === "" ? undefined : String(value)
  filters.value = { ...filters.value, [key]: next }
}

function onReset(): void {
  emit("reset")
}

function onDismiss(): void {
  emit("update:open", false)
}
</script>

<style scoped>
.section-icon {
  width: 22px;
  height: 22px;
  margin-inline-end: 12px;
  color: var(--ion-color-medium, currentColor);
  flex: 0 0 auto;
}

.count-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  padding: 0 8px;
  border-radius: 999px;
  background: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1.5;
}

.segment-row {
  --inner-padding-end: 0;
  --inner-padding-start: 0;
}

.segment-row-inner {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  padding: 8px 0;
}

.segment-label {
  display: flex;
  align-items: center;
}

ion-segment {
  --background: var(--ion-color-light, rgba(0, 0, 0, 0.06));
}
</style>
