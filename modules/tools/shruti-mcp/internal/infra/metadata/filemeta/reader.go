// Package filemeta reads a track's metadata from a JSON file the importer
// wrote next to the mp3, instead of re-deriving it from the filename.
//
// An importer that pulls from a source with real metadata — a site API, a
// catalog export — already knows the title, date, author, location and
// scripture references exactly. Encoding all that into a filename and parsing
// it back loses whatever the naming grammar can't express (the canonical
// grammar, for one, cannot say "dated recording with no location"), so the
// metadata file carries the values verbatim and already normalized.
//
// Two placements are accepted, checked in this order:
//
//	<dir>/<name>.meta.json   named after the track — for directories holding many mp3s
//	<dir>/meta.json          one per directory — for a directory per track
//
// Lookup is by PATH, so it keeps working after ingest moves the mp3 into
// out/artifacts/: the registry still holds the original lake path, and the
// metadata file stays where the importer left it.
//
// No metadata file → fall through to Fallback (canonical parser, then LLM).
// One that exists but is malformed is an error rather than a silent
// downgrade — the importer wrote it, so a mistake there should surface.
package filemeta

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
	metaport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/metadata"
)

// Suffix names the per-track placement; Basename the per-directory one.
const (
	Suffix   = ".meta.json"
	Basename = "meta.json"
)

// Doc is the on-disk schema. Unknown keys are ignored, so an importer may keep
// its own richer payload in the same file alongside these.
type Doc struct {
	Title     string   `json:"title"`
	Date      string   `json:"date,omitempty"` // YYYY-MM-DD
	Languages []string `json:"languages,omitempty"`
	Author    string   `json:"author,omitempty"`   // raw name; resolved downstream
	Location  string   `json:"location,omitempty"` // raw name; resolved downstream
	KindTag   string   `json:"kind_tag,omitempty"`
	// References cite the scripture a track is based on. Source is the catalog
	// short_name ("ШБ", "BG"); Tokens follow that source's token scheme
	// ("2.9.2", "16.7"), one entry per verse.
	References []Ref `json:"references,omitempty"`
}

type Ref struct {
	Source string `json:"source"`
	Tokens string `json:"tokens,omitempty"`
}

// Extractor serves the metadata stage from the file, delegating for tracks
// that don't have one. It doubles as the metadata.Reader other stages use.
type Extractor struct {
	// InDir is the lake root that a relative path is resolved against.
	InDir    string
	Fallback metaport.Extractor
}

func (e Extractor) Name() string {
	if e.Fallback != nil {
		return "filemeta|" + e.Fallback.Name()
	}
	return "filemeta"
}

func (e Extractor) Extract(ctx context.Context, relPath string, sourceCodes []string) (track.Metadata, error) {
	md, ok, err := e.Read(relPath)
	if err != nil {
		return track.Metadata{}, err
	}
	if ok {
		return md, nil
	}
	if e.Fallback == nil {
		return track.Metadata{}, fmt.Errorf("filemeta: no %s next to %s and no fallback extractor configured", Basename, relPath)
	}
	return e.Fallback.Extract(ctx, relPath, sourceCodes)
}

// Read implements metadata.Reader: the importer's record for an audio path,
// or ok=false when the track has no metadata file.
func (e Extractor) Read(path string) (track.Metadata, bool, error) {
	doc, ok, err := e.load(path)
	if err != nil || !ok {
		return track.Metadata{}, false, err
	}
	spec, err := doc.spec()
	if err != nil {
		return track.Metadata{}, false, fmt.Errorf("filemeta %s: %w", path, err)
	}
	md, err := track.NewMetadata(spec)
	if err != nil {
		return track.Metadata{}, false, fmt.Errorf("filemeta %s: %w", path, err)
	}
	return md, true, nil
}

func (e Extractor) load(path string) (Doc, bool, error) {
	full := path
	if e.InDir != "" && !filepath.IsAbs(path) {
		full = filepath.Join(e.InDir, path)
	}
	named := strings.TrimSuffix(full, filepath.Ext(full)) + Suffix
	for _, p := range []string{named, filepath.Join(filepath.Dir(full), Basename)} {
		body, err := os.ReadFile(p)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return Doc{}, false, fmt.Errorf("filemeta %s: %w", p, err)
		}
		var doc Doc
		if err := json.Unmarshal(body, &doc); err != nil {
			return Doc{}, false, fmt.Errorf("filemeta %s: %w", p, err)
		}
		return doc, true, nil
	}
	return Doc{}, false, nil
}

func (d Doc) spec() (track.MetadataSpec, error) {
	spec := track.MetadataSpec{
		Title:       strings.TrimSpace(d.Title),
		AuthorRaw:   strings.TrimSpace(d.Author),
		LocationRaw: strings.TrimSpace(d.Location),
		Languages:   d.Languages,
		KindTag:     strings.TrimSpace(d.KindTag),
	}
	if d.Date != "" {
		t, err := time.Parse("2006-01-02", d.Date)
		if err != nil {
			return track.MetadataSpec{}, fmt.Errorf("date %q: %w", d.Date, err)
		}
		spec.Date = &t
	}
	for i, r := range d.References {
		code := strings.TrimSpace(r.Source)
		if code == "" {
			return track.MetadataSpec{}, fmt.Errorf("references[%d]: empty source", i)
		}
		spec.References = append(spec.References, track.RefRaw{
			SourceCode: code,
			Tokens:     strings.TrimSpace(r.Tokens),
		})
	}
	return spec, nil
}

var (
	_ metaport.Extractor = (*Extractor)(nil)
	_ metaport.Reader    = (*Extractor)(nil)
)
