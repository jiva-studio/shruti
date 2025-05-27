/**
 * Feature: Tracks Search Filters
 * 
 * This feature provides a set of components and composables for managing search filters in a user interface.
 */


/* -------------------------------------------------------------------------- */
/*                                 Components                                 */
/* -------------------------------------------------------------------------- */

export { default as SearchFilterChip } from './components/SearchFilterChip.vue'
export { default as SearchFilterChipsList } from './components/SearchFilterChipsList.vue'
export { default as SearchFilterChipWithDateRange } from './components/SearchFilterChipWithDateRange.vue'
export { default as SearchFilterChipWithListItem } from './components/SearchFilterChipWithListItem.vue'
export { default as SearchFilterChipWithListItems } from './components/SearchFilterChipWithListItems.vue'
export { default as SearchFiltersBar } from './components/SearchFiltersBar.vue'

/* -------------------------------------------------------------------------- */
/*                                 Composables                                */
/* -------------------------------------------------------------------------- */

export { useTracksSearchFiltersTask } from './composables/useTracksSearchFiltersTask'