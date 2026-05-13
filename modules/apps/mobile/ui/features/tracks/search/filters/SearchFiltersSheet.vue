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
        <IonItem
          v-for="section in sections"
          :key="section.key"
          button
          :detail="true"
          @click="openSection(section.key)"
        >
          <component :is="section.icon" slot="start" class="section-icon" />
          <IonLabel>
            <h2>{{ section.title }}</h2>
            <p v-if="sectionSummary(section)" class="section-summary">
              {{ sectionSummary(section) }}
            </p>
          </IonLabel>
          <span
            v-if="section.kind === 'multi' && multiCount(section.key) > 0"
            slot="end"
            class="count-pill"
          >
            {{ multiCount(section.key) }}
          </span>
        </IonItem>
      </IonList>
    </IonContent>
  </IonModal>

  <!-- One dialog stacked above the sheet at a time. -->
  <ListItemsSelectorDialog
    v-if="activeMultiSection"
    :title="activeMultiSection.title"
    :open="!!activeMultiSection"
    :items="activeMultiSection.items"
    :selected="multiSelected(activeMultiSection.key)"
    @close="onSectionClose"
    @select="onMultiSelect"
  />
  <ListItemSelectorDialog
    v-if="activeSingleSection"
    :title="activeSingleSection.title"
    :open="!!activeSingleSection"
    :items="activeSingleSection.items"
    :value="singleValue(activeSingleSection.key)"
    allow-empty
    @close="onSectionClose"
    @select="onSingleSelect"
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
} from "@ionic/vue"
import { ListItemsSelectorDialog, ListItemSelectorDialog } from "@ui/components/selectors/index.js"
import type {
  FiltersModel,
  MultiSectionDef,
  MultiSectionKey,
  SearchFilterSectionDef,
  SingleSectionDef,
  SingleSectionKey,
} from "./types.js"

type SectionKey = MultiSectionKey | SingleSectionKey

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

const activeKey = ref<SectionKey | null>(null)

const activeMultiSection = computed<MultiSectionDef | null>(() => {
  const key = activeKey.value
  if (!key) return null
  const section = props.sections.find((s) => s.key === key)
  return section && section.kind === "multi" ? section : null
})

const activeSingleSection = computed<SingleSectionDef | null>(() => {
  const key = activeKey.value
  if (!key) return null
  const section = props.sections.find((s) => s.key === key)
  return section && section.kind === "single" ? section : null
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

function sectionSummary(section: SearchFilterSectionDef): string {
  if (section.kind === "multi") {
    const ids = multiSelected(section.key)
    if (ids.length === 0) return ""
    const titles = ids
      .map((id) => section.items.find((i) => i.id === id)?.title)
      .filter((t): t is string => !!t)
    return titles.join(", ")
  }
  const current = singleValue(section.key)
  if (!current) return ""
  return section.items.find((i) => i.id === current)?.title ?? ""
}

function openSection(key: SectionKey): void {
  activeKey.value = key
}

function onSectionClose(): void {
  activeKey.value = null
}

function onMultiSelect(ids: string[]): void {
  const key = activeKey.value
  if (!key) return
  filters.value = { ...filters.value, [key]: ids }
  activeKey.value = null
}

function onSingleSelect(id: string | undefined): void {
  const key = activeKey.value
  if (!key) return
  filters.value = { ...filters.value, [key]: id }
  activeKey.value = null
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

.section-summary {
  color: var(--ion-color-medium, currentColor);
  font-size: 0.85rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
</style>
