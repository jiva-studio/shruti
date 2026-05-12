// Package dictcrud is a generic application use case for dictionary mutations.
// One UseCase wraps Kind-aware logic; the MCP tools are thin wrappers per
// entity (author/location/source/tag) that pre-bind the Kind.
package dictcrud

import (
	"context"
	"fmt"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
	catalogport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/catalog"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/ids"
)

type UseCase struct {
	Catalog catalogport.DictRepository
	// FuzzyIndex (optional) is rebuilt after each mutation so the
	// metadata extractor's resolver immediately sees newly-created /
	// renamed / deleted entries when prefiltering LLM candidates.
	// nil disables — the index will catch up on its next external
	// rebuild (catalog_refresh) but stale candidates may briefly slip
	// through (Match's race-skip handles gone-id cases gracefully).
	FuzzyIndex catalogport.DictFuzzyIndex
	Minter     ids.Minter
}

// Create mints `<kind>_<nanoid>` and inserts a row per locale.
func (uc UseCase) Create(ctx context.Context, kind catalog.Kind, names map[string]string, shortNames map[string]string) (string, error) {
	if len(names) == 0 {
		return "", fmt.Errorf("create %s: at least one locale name required", kind)
	}
	id := kind.IDPrefix() + uc.Minter.MintTail()
	entry := catalog.DictEntry{Id: id, Names: names, ShortName: shortNames}
	out, err := uc.Catalog.CreateDict(ctx, kind, entry)
	if err != nil {
		return "", err
	}
	uc.refreshFuzzy(ctx)
	return out, nil
}

func (uc UseCase) Update(ctx context.Context, kind catalog.Kind, id, language, fullName, shortName string) error {
	if err := uc.Catalog.UpdateDictLocale(ctx, kind, id, language, fullName, shortName); err != nil {
		return err
	}
	uc.refreshFuzzy(ctx)
	return nil
}

func (uc UseCase) DeleteLocale(ctx context.Context, kind catalog.Kind, id, language string) error {
	if err := uc.Catalog.DeleteDictLocale(ctx, kind, id, language); err != nil {
		return err
	}
	uc.refreshFuzzy(ctx)
	return nil
}

func (uc UseCase) Delete(ctx context.Context, kind catalog.Kind, id string) error {
	if err := uc.Catalog.DeleteDict(ctx, kind, id); err != nil {
		return err
	}
	uc.refreshFuzzy(ctx)
	return nil
}

func (uc UseCase) refreshFuzzy(ctx context.Context) {
	if uc.FuzzyIndex == nil {
		return
	}
	_ = uc.FuzzyIndex.Rebuild(ctx)
}
