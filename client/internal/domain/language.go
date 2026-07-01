package domain

// Language is an ASR language hint as an open BCP-47-ish code (e.g. "ru", "en",
// "de", "uk", "es"). It is deliberately NOT an enumeration and there is NO
// baked-in default: the language comes from the UI/config per meeting, and an
// empty value means "let the engine auto-detect". Whether a given code is
// supported is the engine's concern.
type Language string

// ProviderID identifies a transcription engine. The set of valid IDs is defined
// by whichever adapters are registered at build time (see adapter/transcriber),
// NOT hardcoded here — the domain must not know which engines exist.
type ProviderID string
