/**
 * Track Search Feature
 */

/* -------------------------------------------------------------------------- */
/*                                 Composables                                */
/* -------------------------------------------------------------------------- */

export { useTrackSearchResultsStore } from './composables/useTrackSearchResultsStore'
export { useTracksSearchResults } from './composables/useTracksSearchResults'
export { useTrackSearchFiltersPersistenceTask } from './composables/useTrackSearchFiltersPersistenceTask'
export { type TrackSearchFilters } from './models/TrackSearchFilters'
export { type TrackSearchResultItem } from './models/TrackSearchResultItem'

/* -------------------------------------------------------------------------- */
/*                                 Components                                 */
/* -------------------------------------------------------------------------- */

export { default as SearchResultsSection } from './components/SearchResultsSection.vue'
export { default as TrackStateIndicator } from './components/TrackStateIndicator.vue'