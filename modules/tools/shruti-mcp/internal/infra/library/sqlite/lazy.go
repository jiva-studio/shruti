package sqlitelibrary

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/library"
)

// Lazy opens library.db on demand. Same pattern as sqlitecatalog.Lazy.
type Lazy struct{ Path string }

func NewLazy(path string) *Lazy { return &Lazy{Path: path} }

func (l *Lazy) Close() error { return nil }

// openRO opens library.db for read-only access. Fails fast with a clear
// diagnostic if the file does not exist — read tools should never auto-
// create a library, the source of truth comes from library_import or a
// downloaded artifact.
func (l *Lazy) openRO(ctx context.Context) (*Repo, error) {
	if _, err := os.Stat(l.Path); err != nil {
		return nil, fmt.Errorf("library.db not found at %s — import it first via agent/library_import/import.py", l.Path)
	}
	return Open(ctx, l.Path)
}

// openRW opens library.db for read-write access. Auto-creates the parent
// directory and the SQLite file if missing — write tools (library.attribution.*)
// must work on a clean machine before any library_import has run, so the
// curator can start building canonical attributions immediately. Open()
// runs applyLocalMigrations to ensure the attribution tables exist.
func (l *Lazy) openRW(ctx context.Context) (*Repo, error) {
	if err := os.MkdirAll(filepath.Dir(l.Path), 0o755); err != nil {
		return nil, fmt.Errorf("ensure library dir: %w", err)
	}
	return Open(ctx, l.Path)
}

// open is the legacy read-only path. Kept as a thin alias to openRO so
// existing read-side callers (GetVerse, ListDocuments, ...) keep their
// strict "must already exist" diagnostic.
func (l *Lazy) open(ctx context.Context) (*Repo, error) {
	return l.openRO(ctx)
}

func (l *Lazy) GetVerse(ctx context.Context, sourceID, tokens string) (library.Verse, bool, error) {
	r, err := l.open(ctx)
	if err != nil {
		return library.Verse{}, false, err
	}
	defer r.Close()
	return r.GetVerse(ctx, sourceID, tokens)
}

func (l *Lazy) GetVerseByID(ctx context.Context, id string) (library.Verse, bool, error) {
	r, err := l.open(ctx)
	if err != nil {
		return library.Verse{}, false, err
	}
	defer r.Close()
	return r.GetVerseByID(ctx, id)
}

func (l *Lazy) ListVerses(ctx context.Context, opts library.ListVersesOpts) ([]library.Verse, error) {
	r, err := l.open(ctx)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return r.ListVerses(ctx, opts)
}

func (l *Lazy) GetDocument(ctx context.Context, id string) (library.Document, bool, error) {
	r, err := l.open(ctx)
	if err != nil {
		return library.Document{}, false, err
	}
	defer r.Close()
	return r.GetDocument(ctx, id)
}

func (l *Lazy) ListDocuments(ctx context.Context, opts library.ListDocumentsOpts) ([]library.Document, error) {
	r, err := l.open(ctx)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return r.ListDocuments(ctx, opts)
}

func (l *Lazy) GetTitle(ctx context.Context, sourceID, tokens, language string) (string, bool, error) {
	r, err := l.open(ctx)
	if err != nil {
		return "", false, err
	}
	defer r.Close()
	return r.GetTitle(ctx, sourceID, tokens, language)
}

func (l *Lazy) ListTitles(ctx context.Context, opts library.ListTitlesOpts) ([]library.Title, error) {
	r, err := l.open(ctx)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return r.ListTitles(ctx, opts)
}

// ---------- ATTRIBUTION (write-side via openRW) ----------

func (l *Lazy) AttributionCreate(ctx context.Context, id string, kind library.AttributionKind, language, firstText string) error {
	r, err := l.openRW(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	return r.AttributionCreate(ctx, id, kind, language, firstText)
}

func (l *Lazy) AttributionGet(ctx context.Context, id string) (library.Attribution, bool, error) {
	r, err := l.openRO(ctx)
	if err != nil {
		return library.Attribution{}, false, err
	}
	defer r.Close()
	return r.AttributionGet(ctx, id)
}

func (l *Lazy) AttributionList(ctx context.Context, opts library.ListAttributionsOpts) ([]library.Attribution, error) {
	r, err := l.openRO(ctx)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return r.AttributionList(ctx, opts)
}

func (l *Lazy) AttributionTextAdd(ctx context.Context, id, language, text string) error {
	r, err := l.openRW(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	return r.AttributionTextAdd(ctx, id, language, text)
}

func (l *Lazy) AttributionTextRemove(ctx context.Context, id, language, text string) error {
	r, err := l.openRW(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	return r.AttributionTextRemove(ctx, id, language, text)
}

func (l *Lazy) AttributionRefAdd(ctx context.Context, id string, ref library.AttributionRef) error {
	r, err := l.openRW(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	return r.AttributionRefAdd(ctx, id, ref)
}

func (l *Lazy) AttributionRefRemove(ctx context.Context, id string, ref library.AttributionRef) error {
	r, err := l.openRW(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	return r.AttributionRefRemove(ctx, id, ref)
}

func (l *Lazy) AttributionDelete(ctx context.Context, id string) error {
	r, err := l.openRW(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	return r.AttributionDelete(ctx, id)
}
