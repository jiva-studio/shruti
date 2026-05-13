<template>
  <IonList lines="full" class="ion-no-padding">
    <IonItem
      v-for="section in sections"
      :key="section.key"
      button
      :detail="true"
      @click="emit('enter', section)"
    >
      <IconChip slot="start" class="section-icon-chip">
        <component :is="section.icon" />
      </IconChip>
      <IonLabel>
        <h2>{{ section.title }}</h2>
        <p class="section-summary" :class="{ 'is-placeholder': !summaryFor(section) }">
          {{ summaryFor(section) || $t("search.filters.any") }}
        </p>
      </IonLabel>
      <span
        v-if="section.kind === 'multi' && getMultiCount(filters, section.key) > 0"
        slot="end"
        class="count-pill"
      >
        {{ getMultiCount(filters, section.key) }}
      </span>
    </IonItem>
  </IonList>
</template>

<script setup lang="ts">
import { IonList, IonItem, IonLabel } from "@ionic/vue"
import { IconChip } from "@ui/primitives/index.js"
import { getMultiCount, getSectionSummary } from "./filtersModel.js"
import type { FiltersModel, SearchFilterSectionDef } from "./types.js"

const props = defineProps<{
  sections: readonly SearchFilterSectionDef[]
  filters: FiltersModel
}>()

const emit = defineEmits<{
  enter: [section: SearchFilterSectionDef]
}>()

function summaryFor(section: SearchFilterSectionDef): string {
  return getSectionSummary(props.filters, section)
}
</script>

<style scoped>
.section-icon-chip {
  margin-inline-end: 12px;
  flex: 0 0 auto;
}

.section-icon-chip > :first-child {
  width: 22px;
  height: 22px;
}

.section-summary {
  color: var(--ion-color-medium, currentColor);
  font-size: 0.85rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.section-summary.is-placeholder {
  opacity: 0.6;
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
