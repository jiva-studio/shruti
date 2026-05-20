package sqlitecatalog

import (
	"context"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
)

// --- pack methods on Lazy (open-on-demand wrapper) ---

func (l *Lazy) CreatePackLocale(ctx context.Context, id, language, name string, featured bool, sortOrder int) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.CreatePackLocale(ctx, id, language, name, featured, sortOrder); err != nil {
		return err
	}
	return markModified(l.Path)
}

func (l *Lazy) UpdatePackLocale(ctx context.Context, id, language string, name *string, featured *bool, sortOrder *int) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.UpdatePackLocale(ctx, id, language, name, featured, sortOrder); err != nil {
		return err
	}
	return markModified(l.Path)
}

func (l *Lazy) GetPack(ctx context.Context, id string) (catalog.Pack, map[string][]string, bool, error) {
	r, err := l.open(ctx)
	if err != nil {
		return catalog.Pack{}, nil, false, err
	}
	defer r.Close()
	return r.GetPack(ctx, id)
}

func (l *Lazy) ListPacks(ctx context.Context, opts catalog.PackListOpts) ([]catalog.Pack, error) {
	r, err := l.open(ctx)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return r.ListPacks(ctx, opts)
}

func (l *Lazy) DeletePack(ctx context.Context, id string) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.DeletePack(ctx, id); err != nil {
		return err
	}
	return markModified(l.Path)
}

func (l *Lazy) DeletePackLocale(ctx context.Context, id, language string) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.DeletePackLocale(ctx, id, language); err != nil {
		return err
	}
	return markModified(l.Path)
}

func (l *Lazy) SetPackTracks(ctx context.Context, packID, language string, trackIDs []string) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.SetPackTracks(ctx, packID, language, trackIDs); err != nil {
		return err
	}
	return markModified(l.Path)
}

func (l *Lazy) AddPackTrack(ctx context.Context, packID, language, trackID string, position *int) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.AddPackTrack(ctx, packID, language, trackID, position); err != nil {
		return err
	}
	return markModified(l.Path)
}

func (l *Lazy) RemovePackTrack(ctx context.Context, packID, language, trackID string) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.RemovePackTrack(ctx, packID, language, trackID); err != nil {
		return err
	}
	return markModified(l.Path)
}

func (l *Lazy) TrackLanguages(ctx context.Context, trackID string) ([]string, error) {
	r, err := l.open(ctx)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return r.TrackLanguages(ctx, trackID)
}
