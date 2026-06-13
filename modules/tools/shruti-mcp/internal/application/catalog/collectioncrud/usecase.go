// Package collectioncrud is the application use case for starter-collection
// mutations. Mirrors `dictcrud` for the collection entity: thin orchestration
// over `catalogport.CollectionRepository`, with id minting + id-shape
// validation + the per-locale invariants (track language must match
// collection language).
package collectioncrud

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
	catalogport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/catalog"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/ids"
)

// CollectionIDPattern is the canonical shape: `pack_<12 alnum>`. Caller-
// supplied ids are rejected if they don't match — server mints on the
// happy path, but supports a caller-supplied id when adding a second
// locale to an existing collection.
var CollectionIDPattern = regexp.MustCompile(`^pack_[A-Za-z0-9]{12}$`)

// UseCase wraps a CollectionRepository with id minting + validation.
type UseCase struct {
	Catalog catalogport.CollectionRepository
	Minter  ids.Minter
}

// CreateInput is the user-supplied payload for `collection.create`. ID is
// optional: empty means "mint a new id" (typical first-locale call);
// non-empty means "attach a new locale to this existing collection id".
type CreateInput struct {
	ID        string
	Language  string
	Name      string
	Featured  bool
	SortOrder int
}

// Create inserts a new (id, language) collection row. Returns the canonical id
// (newly minted or echo of the caller-supplied id). Errors on duplicate
// (id, language) — that's an UPDATE, not a CREATE.
func (uc UseCase) Create(ctx context.Context, in CreateInput) (string, error) {
	lang := strings.TrimSpace(in.Language)
	if lang == "" {
		return "", fmt.Errorf("language is required")
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return "", fmt.Errorf("name is required")
	}
	id := strings.TrimSpace(in.ID)
	if id == "" {
		id = catalog.CollectionIDPrefix + uc.Minter.MintTail()
	} else if !CollectionIDPattern.MatchString(id) {
		return "", fmt.Errorf("id %q does not match pack_<12 alnum>", id)
	}
	if err := uc.Catalog.CreateCollectionLocale(ctx, id, lang, name, in.Featured, in.SortOrder); err != nil {
		return "", err
	}
	return id, nil
}

// UpdateInput is the patch payload for `collection.update`. nil pointers
// leave the existing column untouched.
type UpdateInput struct {
	ID        string
	Language  string
	Name      *string
	Featured  *bool
	SortOrder *int
}

func (uc UseCase) Update(ctx context.Context, in UpdateInput) error {
	if !CollectionIDPattern.MatchString(in.ID) {
		return fmt.Errorf("id %q does not match pack_<12 alnum>", in.ID)
	}
	if strings.TrimSpace(in.Language) == "" {
		return fmt.Errorf("language is required")
	}
	return uc.Catalog.UpdateCollectionLocale(ctx, in.ID, in.Language, in.Name, in.Featured, in.SortOrder)
}

func (uc UseCase) Get(ctx context.Context, id string) (catalog.Collection, map[string][]string, bool, error) {
	if !CollectionIDPattern.MatchString(id) {
		return catalog.Collection{}, nil, false, fmt.Errorf("id %q does not match pack_<12 alnum>", id)
	}
	return uc.Catalog.GetCollection(ctx, id)
}

func (uc UseCase) List(ctx context.Context, opts catalog.CollectionListOpts) ([]catalog.Collection, error) {
	return uc.Catalog.ListCollections(ctx, opts)
}

func (uc UseCase) Delete(ctx context.Context, id string) error {
	if !CollectionIDPattern.MatchString(id) {
		return fmt.Errorf("id %q does not match pack_<12 alnum>", id)
	}
	return uc.Catalog.DeleteCollection(ctx, id)
}

func (uc UseCase) DeleteLocale(ctx context.Context, id, language string) error {
	if !CollectionIDPattern.MatchString(id) {
		return fmt.Errorf("id %q does not match pack_<12 alnum>", id)
	}
	if strings.TrimSpace(language) == "" {
		return fmt.Errorf("language is required")
	}
	return uc.Catalog.DeleteCollectionLocale(ctx, id, language)
}

// SetTracks replaces the full ordered membership of (collectionID, language).
// Each candidate track_id must exist and have a `track_variants` row in
// `language`; otherwise the call is rejected wholesale (no partial
// commit — collection composition is a deliberate edit).
func (uc UseCase) SetTracks(ctx context.Context, collectionID, language string, trackIDs []string) error {
	if !CollectionIDPattern.MatchString(collectionID) {
		return fmt.Errorf("id %q does not match pack_<12 alnum>", collectionID)
	}
	if strings.TrimSpace(language) == "" {
		return fmt.Errorf("language is required")
	}
	for _, tid := range trackIDs {
		if err := uc.assertTrackLanguage(ctx, tid, language); err != nil {
			return err
		}
	}
	return uc.Catalog.SetCollectionTracks(ctx, collectionID, language, trackIDs)
}

func (uc UseCase) AddTrack(ctx context.Context, collectionID, language, trackID string, position *int) error {
	if !CollectionIDPattern.MatchString(collectionID) {
		return fmt.Errorf("id %q does not match pack_<12 alnum>", collectionID)
	}
	if strings.TrimSpace(language) == "" {
		return fmt.Errorf("language is required")
	}
	if err := uc.assertTrackLanguage(ctx, trackID, language); err != nil {
		return err
	}
	return uc.Catalog.AddCollectionTrack(ctx, collectionID, language, trackID, position)
}

func (uc UseCase) RemoveTrack(ctx context.Context, collectionID, language, trackID string) error {
	if !CollectionIDPattern.MatchString(collectionID) {
		return fmt.Errorf("id %q does not match pack_<12 alnum>", collectionID)
	}
	if strings.TrimSpace(language) == "" {
		return fmt.Errorf("language is required")
	}
	return uc.Catalog.RemoveCollectionTrack(ctx, collectionID, language, trackID)
}

func (uc UseCase) assertTrackLanguage(ctx context.Context, trackID, language string) error {
	langs, err := uc.Catalog.TrackLanguages(ctx, trackID)
	if err != nil {
		return err
	}
	if len(langs) == 0 {
		return fmt.Errorf("track %q does not exist", trackID)
	}
	for _, l := range langs {
		if l == language {
			return nil
		}
	}
	return fmt.Errorf("track %q has no %s variant (has: %s) — language mismatch with collection",
		trackID, language, strings.Join(langs, ","))
}
