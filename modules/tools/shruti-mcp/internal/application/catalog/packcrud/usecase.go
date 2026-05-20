// Package packcrud is the application use case for starter-pack
// mutations. Mirrors `dictcrud` for the pack entity: thin orchestration
// over `catalogport.PackRepository`, with id minting + id-shape
// validation + the per-locale invariants (track language must match
// pack language).
package packcrud

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
	catalogport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/catalog"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/ids"
)

// PackIDPattern is the canonical shape: `pack_<12 alnum>`. Caller-
// supplied ids are rejected if they don't match — server mints on the
// happy path, but supports a caller-supplied id when adding a second
// locale to an existing pack.
var PackIDPattern = regexp.MustCompile(`^pack_[A-Za-z0-9]{12}$`)

// UseCase wraps a PackRepository with id minting + validation.
type UseCase struct {
	Catalog catalogport.PackRepository
	Minter  ids.Minter
}

// CreateInput is the user-supplied payload for `pack.create`. ID is
// optional: empty means "mint a new id" (typical first-locale call);
// non-empty means "attach a new locale to this existing pack id".
type CreateInput struct {
	ID        string
	Language  string
	Name      string
	Featured  bool
	SortOrder int
}

// Create inserts a new (id, language) pack row. Returns the canonical id
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
		id = catalog.PackIDPrefix + uc.Minter.MintTail()
	} else if !PackIDPattern.MatchString(id) {
		return "", fmt.Errorf("id %q does not match pack_<12 alnum>", id)
	}
	if err := uc.Catalog.CreatePackLocale(ctx, id, lang, name, in.Featured, in.SortOrder); err != nil {
		return "", err
	}
	return id, nil
}

// UpdateInput is the patch payload for `pack.update`. nil pointers
// leave the existing column untouched.
type UpdateInput struct {
	ID        string
	Language  string
	Name      *string
	Featured  *bool
	SortOrder *int
}

func (uc UseCase) Update(ctx context.Context, in UpdateInput) error {
	if !PackIDPattern.MatchString(in.ID) {
		return fmt.Errorf("id %q does not match pack_<12 alnum>", in.ID)
	}
	if strings.TrimSpace(in.Language) == "" {
		return fmt.Errorf("language is required")
	}
	return uc.Catalog.UpdatePackLocale(ctx, in.ID, in.Language, in.Name, in.Featured, in.SortOrder)
}

func (uc UseCase) Get(ctx context.Context, id string) (catalog.Pack, map[string][]string, bool, error) {
	if !PackIDPattern.MatchString(id) {
		return catalog.Pack{}, nil, false, fmt.Errorf("id %q does not match pack_<12 alnum>", id)
	}
	return uc.Catalog.GetPack(ctx, id)
}

func (uc UseCase) List(ctx context.Context, opts catalog.PackListOpts) ([]catalog.Pack, error) {
	return uc.Catalog.ListPacks(ctx, opts)
}

func (uc UseCase) Delete(ctx context.Context, id string) error {
	if !PackIDPattern.MatchString(id) {
		return fmt.Errorf("id %q does not match pack_<12 alnum>", id)
	}
	return uc.Catalog.DeletePack(ctx, id)
}

func (uc UseCase) DeleteLocale(ctx context.Context, id, language string) error {
	if !PackIDPattern.MatchString(id) {
		return fmt.Errorf("id %q does not match pack_<12 alnum>", id)
	}
	if strings.TrimSpace(language) == "" {
		return fmt.Errorf("language is required")
	}
	return uc.Catalog.DeletePackLocale(ctx, id, language)
}

// SetTracks replaces the full ordered membership of (packID, language).
// Each candidate track_id must exist and have a `track_variants` row in
// `language`; otherwise the call is rejected wholesale (no partial
// commit — pack composition is a deliberate edit).
func (uc UseCase) SetTracks(ctx context.Context, packID, language string, trackIDs []string) error {
	if !PackIDPattern.MatchString(packID) {
		return fmt.Errorf("id %q does not match pack_<12 alnum>", packID)
	}
	if strings.TrimSpace(language) == "" {
		return fmt.Errorf("language is required")
	}
	for _, tid := range trackIDs {
		if err := uc.assertTrackLanguage(ctx, tid, language); err != nil {
			return err
		}
	}
	return uc.Catalog.SetPackTracks(ctx, packID, language, trackIDs)
}

func (uc UseCase) AddTrack(ctx context.Context, packID, language, trackID string, position *int) error {
	if !PackIDPattern.MatchString(packID) {
		return fmt.Errorf("id %q does not match pack_<12 alnum>", packID)
	}
	if strings.TrimSpace(language) == "" {
		return fmt.Errorf("language is required")
	}
	if err := uc.assertTrackLanguage(ctx, trackID, language); err != nil {
		return err
	}
	return uc.Catalog.AddPackTrack(ctx, packID, language, trackID, position)
}

func (uc UseCase) RemoveTrack(ctx context.Context, packID, language, trackID string) error {
	if !PackIDPattern.MatchString(packID) {
		return fmt.Errorf("id %q does not match pack_<12 alnum>", packID)
	}
	if strings.TrimSpace(language) == "" {
		return fmt.Errorf("language is required")
	}
	return uc.Catalog.RemovePackTrack(ctx, packID, language, trackID)
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
	return fmt.Errorf("track %q has no %s variant (has: %s) — language mismatch with pack",
		trackID, language, strings.Join(langs, ","))
}
