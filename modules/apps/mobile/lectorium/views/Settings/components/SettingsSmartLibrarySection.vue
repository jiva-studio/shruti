<script setup lang="ts">
import { ref } from "vue"
import { SettingsSadhanaGroup, SmartLibraryDialog } from "@ui/features/settings/index.js"
import { SearchFiltersSheet } from "@ui/features/tracks/search/filters/index.js"
import type { AutoArchiveDelay } from "@lectorium/composables/useAutoArchiveSweep.js"
import type { UseSmartLibraryBindingReturn } from "../composables/useSmartLibraryBinding.js"
import type { SubscriptionBinding } from "../composables/useSubscriptionBinding.js"
import type { FiltersModel } from "@ui/features/tracks/search/filters/index.js"

// The sadhana group plus the two sheets it opens. Pro-gated: a non-subscriber
// gets the paywall instead of the dialog.
const props = defineProps<{
  smartLibrary: UseSmartLibraryBindingReturn
  subscription: SubscriptionBinding
}>()

const filters = defineModel<FiltersModel>("filters", { required: true })
const showActivityTracker = defineModel<boolean>("showActivityTracker", { required: true })
const notificationsEnabled = defineModel<boolean>("notificationsEnabled", { required: true })
const notificationsTime = defineModel<[number, number] | undefined>("notificationsTime")
const targetSeconds = defineModel<number>("targetSeconds", { required: true })
const archiveDelay = defineModel<AutoArchiveDelay>("archiveDelay", { required: true })
const lastArchiveDelay = defineModel<AutoArchiveDelay>("lastArchiveDelay", { required: true })

const dialogOpen = ref(false)
const filtersOpen = ref(false)

function onOpen(): void {
  void (async () => {
    if (await props.subscription.ensurePro("smartLibrary")) dialogOpen.value = true
  })()
}
</script>

<template>
  <SettingsSadhanaGroup
    v-model:show-activity-tracker="showActivityTracker"
    v-model:notifications-enabled="notificationsEnabled"
    v-model:notifications-time="notificationsTime"
    :smart-library-subtitle="smartLibrary.subtitle.value"
    @open-smart-library="onOpen"
  />

  <SmartLibraryDialog
    v-model:target-seconds="targetSeconds"
    v-model:archive-delay="archiveDelay"
    v-model:last-archive-delay="lastArchiveDelay"
    :open="dialogOpen"
    :filter-summary="smartLibrary.filterSummary.value"
    @update:open="dialogOpen = $event"
    @open-filters="filtersOpen = true"
  />

  <SearchFiltersSheet
    v-model:filters="filters"
    :open="filtersOpen"
    :sections="smartLibrary.sections.value"
    :can-reset="smartLibrary.activeFilterCount.value > 0"
    @update:open="filtersOpen = $event"
    @reset="smartLibrary.reset"
  />
</template>
