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
            :size="20"
            :style="{ color: 'var(--ion-color-primary)' }"
          />
        </IonItem>
      </template>
    </IonList>
  </div>
</template>

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

const INNER_SEARCH_THRESHOLD = 10

const props = defineProps<{
  section: SearchFilterSectionDef
}>()

const filtersModel = defineModel<FiltersModel>("filters", { required: true })

const innerSearch = ref<string>("")

const multi = computed(() => asMulti(props.section))
const single = computed(() => asSingle(props.section))

const showInnerSearch = computed(() => props.section.items.length > INNER_SEARCH_THRESHOLD)

const filteredItems = computed<SelectorDialogItem[]>(() => {
  const q = innerSearch.value.trim().toLocaleLowerCase()
  if (!q) return props.section.items
  return props.section.items.filter((i) => i.title.toLocaleLowerCase().includes(q))
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

<style scoped>
.inner-search {
  padding: 0 4px;
}
</style>
