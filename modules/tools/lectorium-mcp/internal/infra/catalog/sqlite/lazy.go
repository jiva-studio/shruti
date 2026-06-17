package sqlitecatalog

import (
	"context"
	"fmt"
	"os"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/catalog"
	catalogport "github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/ports/catalog"
)

// Lazy is an open-on-demand wrapper around current.db. Each method opens a
// fresh connection, runs, and closes — fine for read-mostly access at
// interactive scale. Used because catalog_refresh might run before the file
// exists, and use cases shouldn't hold the file open for the lifetime of
// the server.
type Lazy struct {
	Path string
}

func NewLazy(path string) *Lazy { return &Lazy{Path: path} }

// Close is a no-op for Lazy — each method already closes after itself.
func (l *Lazy) Close() error { return nil }

func (l *Lazy) open(ctx context.Context) (*Repo, error) {
	if _, err := os.Stat(l.Path); err != nil {
		return nil, fmt.Errorf("catalog not refreshed yet (%s) — run catalog_refresh first", l.Path)
	}
	return Open(ctx, l.Path)
}

func (l *Lazy) Scheme(ctx context.Context) (int, error) {
	r, err := l.open(ctx)
	if err != nil {
		return 0, err
	}
	defer r.Close()
	return r.Scheme(ctx)
}

func (l *Lazy) GetDict(ctx context.Context, kind catalog.Kind, id string) (catalog.DictEntry, bool, error) {
	r, err := l.open(ctx)
	if err != nil {
		return catalog.DictEntry{}, false, err
	}
	defer r.Close()
	return r.GetDict(ctx, kind, id)
}

func (l *Lazy) ListDict(ctx context.Context, kind catalog.Kind, opts catalog.ListOpts) ([]catalog.DictEntry, error) {
	r, err := l.open(ctx)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return r.ListDict(ctx, kind, opts)
}

func (l *Lazy) ListTopicCovers(ctx context.Context) ([]catalog.TopicCover, error) {
	r, err := l.open(ctx)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return r.ListTopicCovers(ctx)
}

func (l *Lazy) UsageCount(ctx context.Context, kind catalog.Kind, id string) (int, error) {
	r, err := l.open(ctx)
	if err != nil {
		return 0, err
	}
	defer r.Close()
	return r.UsageCount(ctx, kind, id)
}

func (l *Lazy) LookupIDByName(ctx context.Context, kind catalog.Kind, name, language string) (string, bool, error) {
	r, err := l.open(ctx)
	if err != nil {
		return "", false, err
	}
	defer r.Close()
	return r.LookupIDByName(ctx, kind, name, language)
}

func (l *Lazy) GetTrack(ctx context.Context, id string) (catalog.TrackRow, bool, error) {
	r, err := l.open(ctx)
	if err != nil {
		return catalog.TrackRow{}, false, err
	}
	defer r.Close()
	return r.GetTrack(ctx, id)
}

func (l *Lazy) GetVariant(ctx context.Context, trackID, language string) (catalog.VariantRow, bool, error) {
	r, err := l.open(ctx)
	if err != nil {
		return catalog.VariantRow{}, false, err
	}
	defer r.Close()
	return r.GetVariant(ctx, trackID, language)
}

func (l *Lazy) GetAudios(ctx context.Context, trackID, language string) ([]catalog.AudioRow, error) {
	r, err := l.open(ctx)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return r.GetAudios(ctx, trackID, language)
}

func (l *Lazy) UpsertAudio(ctx context.Context, a catalog.AudioRow) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.UpsertAudio(ctx, a); err != nil {
		return err
	}
	return markModified(l.Path)
}

func (l *Lazy) UpsertAudios(ctx context.Context, rows []catalog.AudioRow) error {
	if len(rows) == 0 {
		return nil
	}
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.UpsertAudios(ctx, rows); err != nil {
		return err
	}
	return markModified(l.Path)
}

func (l *Lazy) GetReferences(ctx context.Context, trackID string) ([]catalog.TrackReference, error) {
	r, err := l.open(ctx)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return r.GetReferences(ctx, trackID)
}

func (l *Lazy) GetTrackTags(ctx context.Context, trackID string) ([]string, error) {
	r, err := l.open(ctx)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return r.GetTrackTags(ctx, trackID)
}

// --- mutating dict methods (delegated to underlying Repo) ---

func (l *Lazy) CreateDict(ctx context.Context, kind catalog.Kind, e catalog.DictEntry) (string, error) {
	r, err := l.open(ctx)
	if err != nil {
		return "", err
	}
	defer r.Close()
	id, err := r.CreateDict(ctx, kind, e)
	if err != nil {
		return "", err
	}
	return id, markModified(l.Path)
}
func (l *Lazy) UpdateDictLocale(ctx context.Context, kind catalog.Kind, id, language, fullName, shortName string) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.UpdateDictLocale(ctx, kind, id, language, fullName, shortName); err != nil {
		return err
	}
	return markModified(l.Path)
}
func (l *Lazy) DeleteDictLocale(ctx context.Context, kind catalog.Kind, id, language string) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.DeleteDictLocale(ctx, kind, id, language); err != nil {
		return err
	}
	return markModified(l.Path)
}
func (l *Lazy) DeleteDict(ctx context.Context, kind catalog.Kind, id string) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.DeleteDict(ctx, kind, id); err != nil {
		return err
	}
	return markModified(l.Path)
}
func (l *Lazy) SaveTrack(ctx context.Context, t catalog.TrackRow, v catalog.VariantRow, audios []catalog.AudioRow, refs []catalog.TrackReference) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.SaveTrack(ctx, t, v, audios, refs); err != nil {
		return err
	}
	return markModified(l.Path)
}
func (l *Lazy) SetVariantOutline(ctx context.Context, trackID, language, outline, description string) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.SetVariantOutline(ctx, trackID, language, outline, description); err != nil {
		return err
	}
	return markModified(l.Path)
}
func (l *Lazy) SetTrackTopics(ctx context.Context, trackID string, weights map[string]float64) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.SetTrackTopics(ctx, trackID, weights); err != nil {
		return err
	}
	return markModified(l.Path)
}
func (l *Lazy) SetTopicCover(ctx context.Context, id, cover string) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.SetTopicCover(ctx, id, cover); err != nil {
		return err
	}
	return markModified(l.Path)
}
func (l *Lazy) GetTopicName(ctx context.Context, id, language string) (string, bool, error) {
	r, err := l.open(ctx)
	if err != nil {
		return "", false, err
	}
	defer r.Close()
	return r.GetTopicName(ctx, id, language)
}
func (l *Lazy) DeleteTrackVariant(ctx context.Context, trackID, language string) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.DeleteTrackVariant(ctx, trackID, language); err != nil {
		return err
	}
	return markModified(l.Path)
}

var _ catalogport.Repository = (*Lazy)(nil)
