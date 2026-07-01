package provider

import "fmt"

// Factory maps a provider name to its constructor. New providers register here.
var Factory = map[string]func(SessionConfig) Transcriber{
	"parakeet": NewParakeet,
	"deepgram": NewDeepgram,
}

// DefaultProvider is used when no provider is named.
const DefaultProvider = "parakeet"

// New builds a Transcriber for the named provider ("" selects the default).
func New(name string, cfg SessionConfig) (Transcriber, error) {
	if name == "" {
		name = DefaultProvider
	}
	ctor, ok := Factory[name]
	if !ok {
		return nil, fmt.Errorf("provider: unknown provider %q", name)
	}
	return ctor(cfg), nil
}
