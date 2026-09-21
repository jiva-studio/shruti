<script setup lang="ts">
import { computed, ref } from "vue"
import { LibraryBanner } from "@ui/features/collections/index.js"
import { SmartLibraryDialog } from "@ui/features/settings/index.js"
import { SearchFiltersSheet } from "@ui/features/tracks/search/filters/index.js"
import { useConfig } from "@shruti/composables/useConfig.js"
import {
  AUTO_ARCHIVE_DELAY_KEY,
  AUTO_ARCHIVE_LAST_DELAY_KEY,
  type AutoArchiveDelay,
} from "@shruti/composables/useAutoArchiveSweep.js"
import { useSmartLibraryBinding } from "@shruti/views/Settings/composables/useSmartLibraryBinding.js"
import { usePurchasesStore } from "@shruti/stores/usePurchasesStore.js"

// Same binding the Settings page drives, so editing it here and there
// reads and writes one persisted set.
const purchases = usePurchasesStore()
const autoDownloadTargetSeconds = useConfig<number>("settings.autoDownloadTargetSeconds", 0)
const autoArchiveDelay = useConfig<AutoArchiveDelay>(AUTO_ARCHIVE_DELAY_KEY, "off")
const autoArchiveLastDelay = useConfig<AutoArchiveDelay>(AUTO_ARCHIVE_LAST_DELAY_KEY, "off")
const isSubscribed = computed(() => purchases.isSubscribed)
const smartLibrary = useSmartLibraryBinding(
  autoDownloadTargetSeconds,
  autoArchiveDelay,
  isSubscribed
)

const dialogOpen = ref(false)
const filtersOpen = ref(false)

// The banner is always shown: it is the feature's entry, not a subscriber's.
// `ensurePro` waits out the entitlement reconcile first, so a subscriber
// tapping in the first seconds after launch gets the dialog, not a sales pitch.
async function onEnter(): Promise<void> {
  if (await purchases.ensurePro("smartLibrary")) dialogOpen.value = true
}
</script>

<template>
  <LibraryBanner
    :title="$t('search.smartLibrary.title')"
    :description="$t('search.smartLibrary.subtitle')"
    :pro-badge="purchases.settled && !purchases.isSubscribed"
    :pro-badge-label="$t('app.proBadge')"
    background="/library/smart-bg.webp"
    background-dark="/library/smart-bg-dark.webp"
    @click="onEnter"
  />

  <SmartLibraryDialog
    v-model:target-seconds="autoDownloadTargetSeconds"
    v-model:archive-delay="autoArchiveDelay"
    v-model:last-archive-delay="autoArchiveLastDelay"
    :open="dialogOpen"
    :filter-summary="smartLibrary.filterSummary.value"
    @update:open="dialogOpen = $event"
    @open-filters="filtersOpen = true"
  />

  <SearchFiltersSheet
    v-model:filters="smartLibrary.filters.value"
    :open="filtersOpen"
    :sections="smartLibrary.sections.value"
    :can-reset="smartLibrary.activeFilterCount.value > 0"
    @update:open="filtersOpen = $event"
    @reset="smartLibrary.reset"
  />
</template>
