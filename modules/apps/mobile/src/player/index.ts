// components:
export { default as PlayerControls } from './components/Player/PlayerControls.vue'
export { default as TranscriptDialog } from './components/Transcript/TranscriptDialog.vue'
export { default as TranscriptText, type TranscriptSection, type TranscriptBlock } from './components/Transcript/TranscriptText.vue'
export { default as LanguageSelector, type TranscriptLanguage } from './components/LanguageSelector.vue'

// containers:
export { default as Player } from './containers/Player.vue'

// composables:
export * from './composables/usePlayerTranscript'
export * from './composables/usePlayerControls'
export * from './composables/usePlayer'
export * from './composables/useSyncPlayerFeature'

// scenarios:
export * from './composables/usePlayerControlsPlayerScenario'

// icons:
export { default as IconCaretDown } from './icons/IconCaretDown.vue'
export { default as IconBookmark } from './icons/IconBookmark.vue'
export { default as IconPlay } from './icons/IconPlay.vue'
