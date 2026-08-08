<template>
  <div class="chips-row">
    <button
      type="button"
      class="chip filters-button"
      :class="{ 'is-active': active.length > 0 }"
      :aria-label="$t('search.filtersButton')"
      @click="emit('open')"
    >
      <IconAdjustmentsHorizontal :size="16" />
      <span v-if="active.length === 0">{{ $t("search.filtersButton") }}</span>
    </button>

    <button
      v-for="chip in active"
      :key="chip.key"
      type="button"
      class="chip chip--filter"
      :aria-label="$t('search.filters.clearOne', { name: chip.title })"
      @click="emit('clear', chip.key)"
    >
      <span class="chip-title">{{ chip.title }}</span>
      <span class="chip-value">{{ chip.summary }}</span>
      <IconX :size="14" class="chip-x" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue"
import { IconAdjustmentsHorizontal, IconX } from "@tabler/icons-vue"
import {
  getSectionSummary,
  type FiltersModel,
  type SearchFilterSectionDef,
} from "@ui/features/tracks/search/filters/index.js"

/**
 * What is currently narrowing the results, as a scrolling row above them.
 *
 * The sheet is where filters are chosen; this is where they are visible while
 * reading the answer, which is when a person notices that the reason they see
 * three lectures is a language they set months ago. Each chip drops its own
 * section; the leading button opens the sheet.
 *
 * Summaries come from `getSectionSummary`, the same function the sheet's own
 * rows use, so a chip and its row can never word the same selection
 * differently.
 */
const props = defineProps<{
  filters: FiltersModel
  sections: readonly SearchFilterSectionDef[]
  /** Sections whose value the user never chose — the locale-seeded language and
   *  the default sort. Shown as chips they would read as three filters somebody
   *  applied on a fresh install, which is the opposite of what they are. */
  defaultSections: ReadonlySet<string>
}>()

const emit = defineEmits<{ open: []; clear: [key: string] }>()

const active = computed(() =>
  props.sections
    .map((section) => ({
      key: section.key,
      title: section.title,
      summary: getSectionSummary(props.filters, section),
    }))
    .filter((chip) => chip.summary.length > 0 && !props.defaultSections.has(chip.key))
)
</script>

<style scoped>
.chips-row {
  display: flex;
  align-items: center;
  gap: 8px;
  overflow-x: auto;
  padding: 4px 16px 10px;
  scroll-padding-inline: 16px;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}

.chips-row::-webkit-scrollbar {
  display: none;
}

.chip {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 70vw;
  height: 30px;
  padding: 0 10px;
  border: none;
  border-radius: 15px;
  /* The same warm surface pill the collection cards and the old "all
     lectures" button use. NOT --ion-color-step-*: that scale inverts in the
     dark theme. */
  background: var(--ion-color-light);
  color: var(--ion-color-light-contrast);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.filters-button {
  color: var(--ion-color-medium);
}

.filters-button.is-active {
  color: var(--ion-color-primary);
}

.chip-title {
  flex: 0 0 auto;
  opacity: 0.6;
}

.chip-value {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.chip-x {
  flex: 0 0 auto;
  opacity: 0.5;
}
</style>
