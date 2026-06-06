<template>
  <div v-if="date" class="date-section">
    <IonList lines="none" class="ion-no-margin ion-no-padding">
      <IonListHeader>
        <IonLabel>{{ $t("search.filters.dateFromLabel") }}</IonLabel>
      </IonListHeader>
      <IonItem>
        <IonLabel>{{ $t("search.filters.dateYear") }}</IonLabel>
        <IonSelect
          :value="edges.from.year"
          interface="popover"
          :placeholder="$t('search.filters.dateAnyYear')"
          @ion-change="(e: SelectChange) => onYearChange('dateFrom', e.detail.value)"
        >
          <IonSelectOption :value="ANY">{{ $t("search.filters.dateAnyYear") }}</IonSelectOption>
          <IonSelectOption v-for="y in date.years" :key="y" :value="y">{{ y }}</IonSelectOption>
        </IonSelect>
      </IonItem>
      <IonItem :disabled="edges.from.year === ANY">
        <IonLabel>{{ $t("search.filters.dateMonth") }}</IonLabel>
        <IonSelect
          :value="edges.from.month"
          interface="popover"
          :placeholder="$t('search.filters.dateAnyMonth')"
          @ion-change="(e: SelectChange) => onMonthChange('dateFrom', e.detail.value)"
        >
          <IonSelectOption :value="ANY">{{ $t("search.filters.dateAnyMonth") }}</IonSelectOption>
          <IonSelectOption v-for="(label, i) in date.monthLabels" :key="i" :value="i + 1">
            {{ label }}
          </IonSelectOption>
        </IonSelect>
      </IonItem>

      <IonListHeader>
        <IonLabel>{{ $t("search.filters.dateToLabel") }}</IonLabel>
      </IonListHeader>
      <IonItem>
        <IonLabel>{{ $t("search.filters.dateYear") }}</IonLabel>
        <IonSelect
          :value="edges.to.year"
          interface="popover"
          :placeholder="$t('search.filters.dateAnyYear')"
          @ion-change="(e: SelectChange) => onYearChange('dateTo', e.detail.value)"
        >
          <IonSelectOption :value="ANY">{{ $t("search.filters.dateAnyYear") }}</IonSelectOption>
          <IonSelectOption v-for="y in date.years" :key="y" :value="y">{{ y }}</IonSelectOption>
        </IonSelect>
      </IonItem>
      <IonItem :disabled="edges.to.year === ANY">
        <IonLabel>{{ $t("search.filters.dateMonth") }}</IonLabel>
        <IonSelect
          :value="edges.to.month"
          interface="popover"
          :placeholder="$t('search.filters.dateAnyMonth')"
          @ion-change="(e: SelectChange) => onMonthChange('dateTo', e.detail.value)"
        >
          <IonSelectOption :value="ANY">{{ $t("search.filters.dateAnyMonth") }}</IonSelectOption>
          <IonSelectOption v-for="(label, i) in date.monthLabels" :key="i" :value="i + 1">
            {{ label }}
          </IonSelectOption>
        </IonSelect>
      </IonItem>
    </IonList>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue"
import { IonList, IonListHeader, IonItem, IonLabel, IonSelect, IonSelectOption } from "@ionic/vue"
import {
  asDate,
  composeDateEdge,
  parseDateEdge,
  setDateEdge,
  type DateEdge,
} from "./filtersModel.js"
import type { FiltersModel, SearchFilterSectionDef } from "./types.js"

/** Sentinel value for the "any" option — IonSelect needs a concrete value. */
const ANY = "" as const

type SelectChange = CustomEvent<{ value: number | typeof ANY }>

const props = defineProps<{
  section: SearchFilterSectionDef
}>()

const filtersModel = defineModel<FiltersModel>("filters", { required: true })

/** Narrowed view of the section — the sheet only mounts this for the date
 *  dimension, but accepting the union keeps the parent binding simple. */
const date = computed(() => asDate(props.section))

/** Year/month per edge, with `ANY` standing in for "not set" so the
 *  select binding stays controlled. */
const edges = computed(() => {
  const from = parseDateEdge(filtersModel.value.dateFrom)
  const to = parseDateEdge(filtersModel.value.dateTo)
  return {
    from: { year: from?.year ?? ANY, month: from?.month ?? ANY },
    to: { year: to?.year ?? ANY, month: to?.month ?? ANY },
  }
})

function onYearChange(edge: DateEdge, raw: number | typeof ANY): void {
  // Clearing the year drops the whole edge — a month alone has no meaning.
  if (raw === ANY) {
    filtersModel.value = setDateEdge(filtersModel.value, edge, undefined)
    return
  }
  const current = parseDateEdge(filtersModel.value[edge])
  filtersModel.value = setDateEdge(filtersModel.value, edge, composeDateEdge(raw, current?.month))
}

function onMonthChange(edge: DateEdge, raw: number | typeof ANY): void {
  const current = parseDateEdge(filtersModel.value[edge])
  // Month is gated on a year by the disabled item, so `current` is set here.
  if (!current) return
  const month = raw === ANY ? undefined : raw
  filtersModel.value = setDateEdge(filtersModel.value, edge, composeDateEdge(current.year, month))
}
</script>

<style scoped>
.date-section {
  padding: 0 4px;
}
</style>
