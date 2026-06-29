// Package collectiongroupcrud is the application use case for collection-group
// mutations — named, ordered shelves of collections. Mirrors collectioncrud:
// thin orchestration over catalogport.CollectionGroupRepository with id minting
// + id-shape validation.
package collectiongroupcrud

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/catalog"
	catalogport "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/catalog"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/ids"
)

// GroupIDPattern is the canonical shape: `group_<12 alnum>`.
var GroupIDPattern = regexp.MustCompile(`^group_[A-Za-z0-9]{12}$`)

type UseCase struct {
	Catalog catalogport.CollectionGroupRepository
	Minter  ids.Minter
}

type CreateInput struct {
	ID          string
	Language    string
	Name        string
	Description string
	Meta        string
	SortOrder   int
}

// Create inserts a new (id, language) group row. Empty ID mints a new id;
// a supplied id attaches a new locale to an existing group.
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
		id = catalog.CollectionGroupIDPrefix + uc.Minter.MintTail()
	} else if !GroupIDPattern.MatchString(id) {
		return "", fmt.Errorf("id %q does not match group_<12 alnum>", id)
	}
	if err := uc.Catalog.CreateCollectionGroupLocale(ctx, id, lang, name, in.Description, in.Meta, in.SortOrder); err != nil {
		return "", err
	}
	return id, nil
}

type UpdateInput struct {
	ID          string
	Language    string
	Name        *string
	Description *string
	Meta        *string
	SortOrder   *int
}

func (uc UseCase) Update(ctx context.Context, in UpdateInput) error {
	if !GroupIDPattern.MatchString(in.ID) {
		return fmt.Errorf("id %q does not match group_<12 alnum>", in.ID)
	}
	if strings.TrimSpace(in.Language) == "" {
		return fmt.Errorf("language is required")
	}
	return uc.Catalog.UpdateCollectionGroupLocale(ctx, in.ID, in.Language, in.Name, in.Description, in.Meta, in.SortOrder)
}

func (uc UseCase) Get(ctx context.Context, id string) (catalog.CollectionGroup, map[string][]string, bool, error) {
	if !GroupIDPattern.MatchString(id) {
		return catalog.CollectionGroup{}, nil, false, fmt.Errorf("id %q does not match group_<12 alnum>", id)
	}
	return uc.Catalog.GetCollectionGroup(ctx, id)
}

func (uc UseCase) List(ctx context.Context, opts catalog.CollectionGroupListOpts) ([]catalog.CollectionGroup, error) {
	return uc.Catalog.ListCollectionGroups(ctx, opts)
}

func (uc UseCase) Delete(ctx context.Context, id string) error {
	if !GroupIDPattern.MatchString(id) {
		return fmt.Errorf("id %q does not match group_<12 alnum>", id)
	}
	return uc.Catalog.DeleteCollectionGroup(ctx, id)
}

func (uc UseCase) DeleteLocale(ctx context.Context, id, language string) error {
	if !GroupIDPattern.MatchString(id) {
		return fmt.Errorf("id %q does not match group_<12 alnum>", id)
	}
	if strings.TrimSpace(language) == "" {
		return fmt.Errorf("language is required")
	}
	return uc.Catalog.DeleteCollectionGroupLocale(ctx, id, language)
}

// SetCollections replaces the ordered membership of (groupID, language). Each
// collection must exist in that language (enforced by the repository).
func (uc UseCase) SetCollections(ctx context.Context, groupID, language string, collectionIDs []string) error {
	if !GroupIDPattern.MatchString(groupID) {
		return fmt.Errorf("id %q does not match group_<12 alnum>", groupID)
	}
	if strings.TrimSpace(language) == "" {
		return fmt.Errorf("language is required")
	}
	return uc.Catalog.SetCollectionGroupCollections(ctx, groupID, language, collectionIDs)
}

func (uc UseCase) AddCollection(ctx context.Context, groupID, language, collectionID string, position *int) error {
	if !GroupIDPattern.MatchString(groupID) {
		return fmt.Errorf("id %q does not match group_<12 alnum>", groupID)
	}
	if strings.TrimSpace(language) == "" {
		return fmt.Errorf("language is required")
	}
	return uc.Catalog.AddCollectionGroupCollection(ctx, groupID, language, collectionID, position)
}

func (uc UseCase) RemoveCollection(ctx context.Context, groupID, language, collectionID string) error {
	if !GroupIDPattern.MatchString(groupID) {
		return fmt.Errorf("id %q does not match group_<12 alnum>", groupID)
	}
	if strings.TrimSpace(language) == "" {
		return fmt.Errorf("language is required")
	}
	return uc.Catalog.RemoveCollectionGroupCollection(ctx, groupID, language, collectionID)
}
