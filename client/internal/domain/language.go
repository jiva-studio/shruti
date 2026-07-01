package domain

// Language is an ASR language hint as an open BCP-47-ish code (e.g. "ru", "en",
// "de", "uk", "es"). It is deliberately NOT an enumeration: adding a language is
// just passing a different string from config/UI — no code change, no central
// list to edit. Whether an engine supports a given code is the engine's concern.
type Language string

// DefaultLanguage is the fallback when a capture plan names none. It is a single
// configurable default, not a closed set — override it per plan.
const DefaultLanguage Language = "ru"

// ProviderID identifies a transcription engine. The set of valid IDs is defined
// by whichever adapters are registered at build time (see adapter/transcriber),
// NOT hardcoded here — the domain must not know which engines exist.
type ProviderID string
