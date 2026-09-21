<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { IonModal, IonContent } from "@ionic/vue"
import SearchFiltersHeader from "./SearchFiltersHeader.vue"
import SearchFiltersList from "./SearchFiltersList.vue"
import SearchFiltersSection from "./SearchFiltersSection.vue"
import SearchFiltersDateSection from "./SearchFiltersDateSection.vue"
import type {
  DateSectionKey,
  FiltersModel,
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

const activeSectionKey = ref<MultiSectionKey | SingleSectionKey | DateSectionKey | null>(null)
const transitionName = ref<"drill-in" | "drill-out">("drill-in")

const activeSection = computed<SearchFilterSectionDef | null>(() => {
  const key = activeSectionKey.value
  if (!key) return null
  return props.sections.find((s) => s.key === key) ?? null
})

// Closing the sheet from outside resets local navigation state so the
// next open lands on the list view, not a stale section.
watch(
  () => props.open,
  (next) => {
    if (!next) activeSectionKey.value = null
  }
)

function enterSection(section: SearchFilterSectionDef): void {
  transitionName.value = "drill-in"
  activeSectionKey.value = section.key
}

function leaveSection(): void {
  transitionName.value = "drill-out"
  activeSectionKey.value = null
}

function onReset(): void {
  emit("reset")
}

// Primary OK in the toolbar: when a sub-picker is on screen it acts as
// "done with this dimension" (mirrors the back chevron); on the root
// view it dismisses the whole sheet. Filters apply live as the user
// toggles them, so closing never loses changes.
function onPrimary(): void {
  if (activeSection.value) {
    leaveSection()
    return
  }
  emit("update:open", false)
}

function onDismiss(): void {
  emit("update:open", false)
}
</script>

<template>
  <IonModal
    :is-open="open"
    class="filters-sheet"
    :breakpoints="[0, 0.5, 0.9]"
    :initial-breakpoint="0.9"
    :expand-to-scroll="false"
    handle
    @did-dismiss="onDismiss"
  >
    <SearchFiltersHeader
      :title="activeSection ? activeSection.title : $t('search.filtersSheetTitle')"
      :drilled="activeSection !== null"
      :can-reset="canReset"
      @back="leaveSection"
      @reset="onReset"
      @primary="onPrimary"
    />

    <IonContent class="filters-content">
      <div class="view-stack">
        <Transition :name="transitionName">
          <!-- List view: every dimension as a drill-in row. -->
          <SearchFiltersList
            v-if="!activeSection"
            key="list"
            class="view"
            :sections="sections"
            :filters="filters"
            @enter="enterSection"
          />

          <!-- Date range gets its own picker (year + optional month per edge). -->
          <SearchFiltersDateSection
            v-else-if="activeSection.kind === 'date'"
            :key="`section-${activeSection.key}`"
            v-model:filters="filters"
            class="view"
            :section="activeSection"
          />

          <!-- Section detail view: the picker for the focused dimension. -->
          <SearchFiltersSection
            v-else
            :key="`section-${activeSection.key}`"
            v-model:filters="filters"
            class="view"
            :section="activeSection"
          />
        </Transition>
      </div>
    </IonContent>
  </IonModal>
</template>

<style>
/* `expand-to-scroll="false"` on the modal keeps the sheet at a fixed
   height and routes content drags to IonContent's scroll. Surface a
   visible scrollbar so long lists (e.g. Languages) read as scrollable
   rather than inviting a modal-handle drag. */
.filters-sheet .filters-content::part(scroll)::-webkit-scrollbar {
  width: 6px;
}
.filters-sheet .filters-content::part(scroll)::-webkit-scrollbar-thumb {
  background: var(--ion-color-medium);
  border-radius: 3px;
}
</style>
<style scoped>
.view-stack {
  position: relative;
  min-height: 100%;
  overflow-x: hidden;
}

.view {
  width: 100%;
}

/* Drill transitions run concurrently. The OUTGOING view becomes
   absolutely positioned over the incoming one so they slide past each
   other instead of one fully leaving before the other appears. The
   incoming view stays in normal flow so IonContent's scroll height
   reflects its content. */
.drill-in-leave-active,
.drill-out-leave-active {
  position: absolute;
  inset: 0;
}

/* Drill-in (entering a section): incoming slides from the right. */
.drill-in-enter-active,
.drill-in-leave-active,
.drill-out-enter-active,
.drill-out-leave-active {
  transition:
    transform 200ms ease,
    opacity 200ms ease;
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
