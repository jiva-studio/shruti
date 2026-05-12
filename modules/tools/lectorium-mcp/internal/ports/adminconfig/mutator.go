// Package adminconfig is the port for runtime config mutations driven by
// admin_config_set. Application code depends on these interfaces; the
// concrete adapter (internal/infra/adminconfig/runtime) reaches into the
// transcriber / reviewer registries to apply the change.
package adminconfig

import "context"

// EndpointMutator flips one provider's upstream URL at runtime. Returns
// the previous endpoint string (empty when the provider didn't expose
// an Endpoint() method or had no prior URL set).
type EndpointMutator interface {
	SetTranscriberEndpoint(ctx context.Context, name, url string) (prev string, err error)
}

// DefaultMutator changes which provider serves as the per-domain default
// (transcribe / review). Returns the previous default name and the
// available alternatives so the caller's confirmation message can list
// what else they could have chosen.
type DefaultMutator interface {
	SetDefaultTranscriber(ctx context.Context, name string) (prev string, available []string, err error)
}

// SnapshotProvider returns the live config tree (sanitize + endpoint
// overlay applied), used by admin_config_get.
type SnapshotProvider interface {
	Snapshot(ctx context.Context) (map[string]any, error)
}
