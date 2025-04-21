/* -------------------------------------------------------------------------- */
/*                                UI Components                               */
/* -------------------------------------------------------------------------- */

// components:
export { default as PlayerControls } from './components/Player/PlayerControls.vue'
export { default as TranscriptDialog } from './components/Transcript/TranscriptDialog.vue'
export { default as TranscriptText, type TranscriptSection, type TranscriptBlock } from './components/Transcript/TranscriptText.vue'
export { default as LanguageSelector, type TranscriptLanguage } from './components/LanguageSelector.vue'

// containers:
export { default as Player } from './containers/Player.vue'

// icons:
export { default as IconCaretDown } from './icons/IconCaretDown.vue'
export { default as IconBookmark } from './icons/IconBookmark.vue'
export { default as IconPlay } from './icons/IconPlay.vue'

/* -------------------------------------------------------------------------- */
/*                               Business Logic                               */
/* -------------------------------------------------------------------------- */

// composables:
export * from './composables/usePlayerTranscript'
export * from './composables/usePlayerControls'
export * from './composables/usePlayer'

// scenarios:
export * from './composables/usePlayerControlsPlayerScenario'

// features:
export * from './features/useSyncAudioPlayerPluginState'
export * from './features/useSetPlayerControlsInfo'

