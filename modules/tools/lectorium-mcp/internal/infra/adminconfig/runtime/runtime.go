// Package runtime is the infra adapter that implements the adminconfig
// ports (EndpointMutator, DefaultMutator, SnapshotProvider) by reaching
// into the live transcriber registry and the loaded *config.Config.
//
// Endpointer / EndpointSwapper interfaces relocated here from the MCP
// handler — they describe a runtime contract concrete transcribers may
// satisfy (transcriber-service does; local-binary providers don't).
package runtime

import (
	"context"
	"fmt"
	"strings"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/config"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/transcriber"
)

// Endpointer is implemented by transcribe-providers whose upstream URL
// is observable. Used by Snapshot so admin_config_get reflects the live
// URL after a runtime swap, not the yaml snapshot.
type Endpointer interface {
	Endpoint() string
}

// EndpointSwapper is implemented by transcribe-providers whose upstream
// URL can be flipped at runtime. transcriber-service implements this;
// local-binary providers wouldn't.
type EndpointSwapper interface {
	SetEndpoint(url string) error
}

// Adapter wires the transcriber registry + config into the adminconfig
// ports. Constructed by the composition root; callers pass it into
// adminconfig.Service.
type Adapter struct {
	Transcribers transcriber.Registry
	Config       *config.Config
}

// SetTranscriberEndpoint implements ports/adminconfig.EndpointMutator.
func (a *Adapter) SetTranscriberEndpoint(_ context.Context, name, value string) (prev string, err error) {
	t, ok := a.Transcribers.Get(name)
	if !ok {
		return "", fmt.Errorf("provider %q not registered. Available: %s",
			name, strings.Join(a.Transcribers.List(), ", "))
	}
	swapper, ok := t.(EndpointSwapper)
	if !ok {
		return "", fmt.Errorf("provider %q (kind=%s) doesn't support endpoint mutation",
			name, t.Name())
	}
	if e, ok := t.(Endpointer); ok {
		prev = e.Endpoint()
	}
	if err := swapper.SetEndpoint(value); err != nil {
		return "", err
	}
	return prev, nil
}

// SetDefaultTranscriber implements ports/adminconfig.DefaultMutator.
func (a *Adapter) SetDefaultTranscriber(_ context.Context, name string) (prev string, available []string, err error) {
	available = a.Transcribers.List()
	if !contains(available, name) {
		return "", available, fmt.Errorf("provider %q not registered. Available: %s",
			name, strings.Join(available, ", "))
	}
	if d := a.Transcribers.Default(); d != nil {
		prev = d.Name()
	}
	a.Transcribers.SetDefault(name)
	return prev, available, nil
}

// Snapshot implements ports/adminconfig.SnapshotProvider. Sanitize the
// loaded config (redact secrets) and overlay the live endpoint URLs
// any transcriber that satisfies Endpointer reports.
func (a *Adapter) Snapshot(_ context.Context) (map[string]any, error) {
	tree := config.Sanitize(a.Config)
	tx, _ := tree["transcribe"].(map[string]any)
	if tx == nil {
		return tree, nil
	}
	provs, _ := tx["providers"].(map[string]any)
	if provs == nil {
		return tree, nil
	}
	for _, name := range a.Transcribers.List() {
		t, ok := a.Transcribers.Get(name)
		if !ok {
			continue
		}
		ep, ok := t.(Endpointer)
		if !ok {
			continue
		}
		entry, _ := provs[name].(map[string]any)
		if entry == nil {
			entry = map[string]any{}
			provs[name] = entry
		}
		entry["endpoint"] = ep.Endpoint()
	}
	return tree, nil
}

func contains(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}
