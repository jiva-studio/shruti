package sqlitelibrary

import (
	"context"
	"fmt"
	"os"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/library"
)

// Lazy opens library.db on demand. Same pattern as sqlitecatalog.Lazy.
type Lazy struct{ Path string }

func NewLazy(path string) *Lazy { return &Lazy{Path: path} }

func (l *Lazy) Close() error { return nil }

func (l *Lazy) open(ctx context.Context) (*Repo, error) {
	if _, err := os.Stat(l.Path); err != nil {
		return nil, fmt.Errorf("library.db not found at %s — import it first via agent/library_import/import.py", l.Path)
	}
	return Open(ctx, l.Path)
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
