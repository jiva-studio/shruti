// Package audiotag composes ID3 tags for a committed track from catalog
// data and writes them into the public mp3. Invoked automatically at the
// end of commit and exposed as the standalone MCP tool track_tag_audio
// (re-tag after track_set_metadata edits without re-running the pipeline).
package audiotag

import (
	"context"
	"fmt"
	"strings"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/track"
	audioport "github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/ports/audio"
	catalogport "github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/ports/catalog"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/ports/tagger"
)

type UseCase struct {
	Catalog catalogport.CommitRepository
	Audio   audioport.Store
	Tagger  tagger.Tagger
}

type Result struct {
	TrackId    track.Id `json:"track_id"`
	Language   string   `json:"language"`
	AudioPath  string   `json:"audio_path"`
	Title      string   `json:"title"`
	Artist     string   `json:"artist"`
	Album      string   `json:"album,omitempty"`
	Genre      string   `json:"genre,omitempty"`
	Year       string   `json:"year,omitempty"`
	Recording  string   `json:"recording_date,omitempty"`
}

// Run reads the committed (track, language) state from the catalog and writes
// the resulting ID3 frames into out/public/tracks/{id}/audio/original.mp3.
// Idempotent: prior ID3 frames on the file are dropped before writing.
func (uc UseCase) Run(ctx context.Context, id track.Id, language string) (Result, error) {
	tr, ok, err := uc.Catalog.GetTrack(ctx, string(id))
	if err != nil {
		return Result{}, fmt.Errorf("get track %s: %w", id, err)
	}
	if !ok {
		return Result{}, fmt.Errorf("audiotag: track %s not committed yet", id)
	}
	v, ok, err := uc.Catalog.GetVariant(ctx, string(id), language)
	if err != nil {
		return Result{}, fmt.Errorf("get variant %s/%s: %w", id, language, err)
	}
	if !ok {
		return Result{}, fmt.Errorf("audiotag: variant %s/%s not committed yet", id, language)
	}
	refs, err := uc.Catalog.GetReferences(ctx, string(id))
	if err != nil {
		return Result{}, fmt.Errorf("get references %s: %w", id, err)
	}
	tagIDs, err := uc.Catalog.GetTrackTags(ctx, string(id))
	if err != nil {
		return Result{}, fmt.Errorf("get track tags %s: %w", id, err)
	}

	author := uc.dictName(ctx, catalog.KindAuthor, tr.AuthorID, language)
	location := uc.dictName(ctx, catalog.KindLocation, tr.LocationID, language)

	primarySourceShort := ""
	primarySourceFull := ""
	if len(refs) > 0 {
		entry, ok, err := uc.Catalog.GetDict(ctx, catalog.KindSource, refs[0].SourceID)
		if err == nil && ok {
			primarySourceShort = entry.ShortName[language]
			primarySourceFull = entry.Names[language]
		}
	}

	primaryTagID := ""
	if len(tagIDs) > 0 {
		primaryTagID = tagIDs[0]
	}
	genre := uc.dictName(ctx, catalog.KindTag, primaryTagID, language)
	if genre == "" {
		genre = defaultGenre(language)
	}

	title := buildTitle(primarySourceShort, refs, location, v.Title)

	tags := tagger.Tags{
		Title:         title,
		Artist:        author,
		AlbumArtist:   author,
		Album:         primarySourceFull,
		RecordingDate: tr.Date,
		Year:          year(tr.Date),
		Genre:         genre,
		Language:      language,
		Comment:       buildComment(v.SortReference, tr.Date),
		TrackID:       string(id),
	}

	audioPath := uc.Audio.PublicAudioPath(id, audioport.VersionOriginal)
	if err := uc.Tagger.Tag(ctx, audioPath, tags); err != nil {
		return Result{}, err
	}

	return Result{
		TrackId:   id,
		Language:  language,
		AudioPath: audioPath,
		Title:     title,
		Artist:    author,
		Album:     primarySourceFull,
		Genre:     genre,
		Year:      year(tr.Date),
		Recording: tr.Date,
	}, nil
}

func (uc UseCase) dictName(ctx context.Context, kind catalog.Kind, id, language string) string {
	if id == "" {
		return ""
	}
	entry, ok, err := uc.Catalog.GetDict(ctx, kind, id)
	if err != nil || !ok {
		return ""
	}
	return entry.Names[language]
}

// buildTitle composes "{src} {tokens} — {title} — {location}" when there's a
// primary reference; otherwise falls back to "{title} — {location}" or just
// the title. Empty parts are dropped.
func buildTitle(srcShort string, refs []catalog.TrackReference, location, title string) string {
	parts := []string{}
	if srcShort != "" && len(refs) > 0 && refs[0].Tokens != "" {
		parts = append(parts, srcShort+" "+refs[0].Tokens)
	}
	if title != "" {
		parts = append(parts, title)
	}
	if location != "" {
		parts = append(parts, location)
	}
	return strings.Join(parts, " — ")
}

func buildComment(sortRef *string, date string) string {
	parts := []string{}
	if sortRef != nil && *sortRef != "" {
		parts = append(parts, *sortRef)
	}
	if date != "" {
		parts = append(parts, date)
	}
	return strings.Join(parts, " / ")
}

func year(date string) string {
	if len(date) >= 4 {
		return date[:4]
	}
	return ""
}

func defaultGenre(language string) string {
	switch language {
	case "ru":
		return "Лекция"
	case "en":
		return "Lecture"
	}
	return "Lecture"
}
