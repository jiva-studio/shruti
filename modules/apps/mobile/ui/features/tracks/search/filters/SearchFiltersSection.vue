<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { IonList, IonItem, IonLabel, IonCheckbox, type CheckboxCustomEvent } from "@ionic/vue"
import { IconCheckFilled } from "@tabler/icons-vue"
import { SearchInput } from "@ui/components/tracks/search/input/index.js"
import type { SelectorDialogItem } from "@ui/components/selectors/index.js"
import {
  asMulti,
  asSingle,
  getSingleValue,
  isMultiSelected,
  setMultiSelected,
  toggleSingleValue,
} from "./filtersModel.js"
import type { FiltersModel, SearchFilterSectionDef } from "./types.js"

const props = defineProps<{
  section: SearchFilterSectionDef
}>()

const filtersModel = defineModel<FiltersModel>("filters", { required: true })

const INNER_SEARCH_THRESHOLD = 10

const innerSearch = ref<string>("")

const multi = computed(() => asMulti(props.section))
const single = computed(() => asSingle(props.section))

// The date dimension renders in its own component, so this picker only ever
// sees multi/single sections — both of which carry `items`.
const items = computed<SelectorDialogItem[]>(() => (multi.value ?? single.value)?.items ?? [])

const showInnerSearch = computed(() => items.value.length > INNER_SEARCH_THRESHOLD)

const filteredItems = computed<SelectorDialogItem[]>(() => {
  const q = innerSearch.value.trim().toLocaleLowerCase()
  if (!q) return items.value
  return items.value.filter((i) => i.title.toLocaleLowerCase().includes(q))
})

// Reset the in-section search whenever the parent swaps sections.
watch(
  () => props.section.key,
  () => {
    innerSearch.value = ""
  }
)

function onMultiChange(id: string, checked: boolean): void {
  if (!multi.value) return
  filtersModel.value = setMultiSelected(filtersModel.value, multi.value.key, id, checked)
}

function onSingleClick(id: string | undefined): void {
  if (!single.value) return
  filtersModel.value = toggleSingleValue(filtersModel.value, single.value.key, id)
}
</script>

<template>
  <div>
    <div v-if="showInnerSearch" class="inner-search">
      <SearchInput v-model="innerSearch" :placeholder="$t('app.search')" />
    </div>
    <IonList lines="none" class="ion-no-margin ion-no-padding">
      <template v-if="multi">
        <IonItem v-for="item in filteredItems" :key="item.id">
          <IonCheckbox
            label-placement="end"
            justify="start"
            :checked="isMultiSelected(filtersModel, multi.key, item.id)"
            @ion-change="(e: CheckboxCustomEvent) => onMultiChange(item.id, e.detail.checked)"
          >
            {{ item.title }}
          </IonCheckbox>
        </IonItem>
      </template>
      <template v-else-if="single">
        <IonItem
          v-for="item in filteredItems"
          :key="item.id ?? '__unset__'"
          button
          @click="onSingleClick(item.id)"
        >
          <IonLabel>{{ item.title }}</IonLabel>
          <IconCheckFilled
            v-if="getSingleValue(filtersModel, single.key) === item.id"
            slot="end"
            class="filter-check"
            :size="20"
          />
        </IonItem>
      </template>
    </IonList>
  </div>
</template>

<style scoped>
.filter-check {
  color: var(--ion-color-primary);
}

.inner-search {
  padding: 0 4px;
}
</style>
