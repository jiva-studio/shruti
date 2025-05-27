// components:
export { default as PlayerControls } from './components/Player/PlayerControls.vue'
export { default as TranscriptDialog } from './components/Transcript/TranscriptDialog.vue'
export { default as TranscriptText, type TranscriptSection, type TranscriptBlock } from './components/Transcript/TranscriptText.vue'
export { default as LanguageSelector, type TranscriptLanguage } from './components/LanguageSelector.vue'

// containers:
export { default as Player } from './components/Player.vue'
export { default as Transcript } from './components/Transcript.vue'

// composables:
export * from './composables/usePlayerTranscript'
export * from './composables/usePlayerControls'
export * from './composables/usePlayer'
export * from './composables/usePlayerControlsPlayerScenario'
export * from './composables/useSyncAudioPlayerPluginStateFeature'
export * from './composables/useSyncPlayerControlsInfoFeature'

