<template>
  <!-- v-if so the modal fully unmounts after swipe-dismiss; without it
       IonModal with breakpoints holds onto internal state and the next
       :is-open=true wouldn't re-open. -->
  <IonModal
    v-if="open"
    :is-open="true"
    class="filters-sheet"
    :breakpoints="[0, 0.5, 0.9]"
    :initial-breakpoint="0.9"
    handle
    @did-dismiss="onDismiss"
  >
    <Header>
      <IonToolbar>
        <IonButtons v-if="activeSection" slot="start">
          <IonButton @click="leaveSection">
            <IonIcon slot="icon-only" :icon="chevronBackOutline" />
          </IonButton>
        </IonButtons>
        <IonTitle>
          {{ activeSection ? activeSection.title : $t("search.filtersSheetTitle") }}
        </IonTitle>
        <IonButtons v-if="!activeSection" slot="end">
          <IonButton :disabled="!canReset" @click="onReset">
            {{ $t("search.filtersReset") }}
          </IonButton>
        </IonButtons>
      </IonToolbar>
    </Header>

    <IonContent>
      <Transition :name="transitionName" mode="out-in">
        <!-- List view: every dimension as a drill-in row. -->
        <div v-if="!activeSection" key="list" class="view">
          <IonList lines="full" class="ion-no-padding">
            <IonItem
              v-for="section in sections"
              :key="section.key"
              button
              :detail="true"
              @click="enterSection(section)"
            >
              <component :is="section.icon" slot="start" class="section-icon" />
              <IonLabel>
                <h2>{{ section.title }}</h2>
                <p
                  class="section-summary"
                  :class="{ 'is-placeholder': !sectionSummary(section) }"
                >
                  {{ sectionSummary(section) || $t("search.filters.any") }}
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
        </div>

        <!-- Section detail view: the picker for the focused dimension. -->
        <div v-else :key="`section-${activeSectionKey}`" class="view">
          <div v-if="showInnerSearch" class="inner-search">
            <SearchInput v-model="innerSearch" :placeholder="$t('app.search')" />
          </div>
          <IonList lines="none" class="ion-no-margin ion-no-padding">
            <template v-if="multiActive">
              <IonItem v-for="item in filteredItems" :key="item.id">
                <IonCheckbox
                  label-placement="end"
                  justify="start"
                  :checked="isMultiSelected(multiActive.key, item.id)"
                  @ion-change="(e) => toggleMulti(multiActive!.key, item.id, e.detail.checked)"
                >
                  {{ item.title }}
                </IonCheckbox>
              </IonItem>
            </template>
            <template v-else-if="singleActive">
              <IonItem
                v-for="item in filteredItems"
                :key="item.id ?? '__unset__'"
                button
                @click="toggleSingle(singleActive!.key, item.id)"
              >
                <IonLabel>{{ item.title }}</IonLabel>
                <IonIcon
                  v-if="singleValue(singleActive.key) === item.id"
                  slot="end"
                  :icon="checkmark"
                  color="primary"
                />
              </IonItem>
            </template>
          </IonList>
        </div>
      </Transition>
    </IonContent>
  </IonModal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue"
import {
  IonModal,
  IonToolbar,
  IonTitle,
  IonButtons,
  IonButton,
  IonIcon,
  IonContent,
  IonList,
  IonItem,
  IonLabel,
  IonCheckbox,
} from "@ionic/vue"
import { chevronBackOutline, checkmark } from "ionicons/icons"
import { Header } from "@ui/primitives/index.js"
import { SearchInput } from "@ui/components/tracks/search/input/index.js"
import type { SelectorDialogItem } from "@ui/components/selectors/index.js"
import type {
  FiltersModel,
  MultiSectionDef,
  MultiSectionKey,
  SearchFilterSectionDef,
  SingleSectionDef,
  SingleSectionKey,
} from "./types.js"

const INNER_SEARCH_THRESHOLD = 10

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

const activeSectionKey = ref<MultiSectionKey | SingleSectionKey | null>(null)
const transitionName = ref<"drill-in" | "drill-out">("drill-in")
const innerSearch = ref<string>("")

const activeSection = computed<SearchFilterSectionDef | null>(() => {
  const key = activeSectionKey.value
  if (!key) return null
  return props.sections.find((s) => s.key === key) ?? null
})

const multiActive = computed<MultiSectionDef | null>(() =>
  activeSection.value && activeSection.value.kind === "multi" ? activeSection.value : null
)

const singleActive = computed<SingleSectionDef | null>(() =>
  activeSection.value && activeSection.value.kind === "single" ? activeSection.value : null
)

const showInnerSearch = computed(
  () => !!activeSection.value && activeSection.value.items.length > INNER_SEARCH_THRESHOLD
)

const filteredItems = computed<SelectorDialogItem[]>(() => {
  const section = activeSection.value
  if (!section) return []
  const q = innerSearch.value.trim().toLocaleLowerCase()
  if (!q) return section.items
  return section.items.filter((i) => i.title.toLocaleLowerCase().includes(q))
})

// Closing the sheet from outside resets local navigation state so the
// next open lands on the list view, not a stale section.
watch(
  () => props.open,
  (next) => {
    if (!next) {
      activeSectionKey.value = null
      innerSearch.value = ""
    }
  }
)

function enterSection(section: SearchFilterSectionDef): void {
  transitionName.value = "drill-in"
  activeSectionKey.value = section.key
  innerSearch.value = ""
}

function leaveSection(): void {
  transitionName.value = "drill-out"
  activeSectionKey.value = null
  innerSearch.value = ""
}

function multiSelected(key: MultiSectionKey): string[] {
  return (filters.value[key] as string[] | undefined) ?? []
}

function multiCount(key: MultiSectionKey): number {
  return multiSelected(key).length
}

function isMultiSelected(key: MultiSectionKey, id: string): boolean {
  return multiSelected(key).includes(id)
}

function toggleMulti(key: MultiSectionKey, id: string, checked: boolean): void {
  const current = multiSelected(key)
  const next = checked
    ? current.includes(id)
      ? current
      : [...current, id]
    : current.filter((x) => x !== id)
  filters.value = { ...filters.value, [key]: next }
}

function singleValue(key: SingleSectionKey): string | undefined {
  return filters.value[key] as string | undefined
}

function toggleSingle(key: SingleSectionKey, id: string | undefined): void {
  const current = singleValue(key)
  filters.value = { ...filters.value, [key]: current === id ? undefined : id }
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

function onReset(): void {
  emit("reset")
}

function onDismiss(): void {
  emit("update:open", false)
}
</script>

<style>
/* Same fix as SelectorDialog in sheet mode: kill the Android toolbar
   elevation under the sheet's own header. */
.filters-sheet ion-header::after {
  display: none;
  background-image: none;
}
</style>

<style scoped>
.view {
  width: 100%;
}

.inner-search {
  padding: 0 4px;
}

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

/* Drill-in (entering a section): incoming slides from the right. */
.drill-in-enter-active,
.drill-in-leave-active,
.drill-out-enter-active,
.drill-out-leave-active {
  transition: transform 200ms ease, opacity 200ms ease;
}
.drill-in-enter-from {
  transform: translateX(100%);
  opacity: 0;
}
.drill-in-leave-to {
  transform: translateX(-100%);
  opacity: 0;
}

/* Drill-out (back to list): incoming slides from the left. */
.drill-out-enter-from {
  transform: translateX(-100%);
  opacity: 0;
}
.drill-out-leave-to {
  transform: translateX(100%);
  opacity: 0;
}
</style>
