// Package id3v2tagger writes ID3v2.4 frames into mp3 files via
// github.com/bogem/id3v2/v2. UTF-8 throughout.
package id3v2tagger

import (
	"context"
	"fmt"

	"github.com/bogem/id3v2/v2"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/ports/tagger"
)

type Tagger struct{}

func New() Tagger { return Tagger{} }

// Tag opens mp3Path, drops any prior ID3 tag (so we don't accumulate stale
// frames across repeated runs) and writes the requested frames as ID3v2.4
// with UTF-8 encoding. Empty fields on the Tags struct are skipped.
func (Tagger) Tag(ctx context.Context, mp3Path string, t tagger.Tags) error {
	tag, err := id3v2.Open(mp3Path, id3v2.Options{Parse: true})
	if err != nil {
		return fmt.Errorf("id3v2 open %s: %w", mp3Path, err)
	}
	defer tag.Close()

	tag.SetVersion(4)
	tag.SetDefaultEncoding(id3v2.EncodingUTF8)

	// Replace, don't merge: a re-tag should reflect current catalog state.
	tag.DeleteAllFrames()

	if t.Title != "" {
		tag.SetTitle(t.Title)
	}
	if t.Artist != "" {
		tag.SetArtist(t.Artist)
	}
	if t.AlbumArtist != "" {
		tag.AddTextFrame("TPE2", id3v2.EncodingUTF8, t.AlbumArtist)
	}
	if t.Album != "" {
		tag.SetAlbum(t.Album)
	}
	if t.RecordingDate != "" {
		// ID3v2.4 TDRC accepts ISO 8601; we already pass YYYY-MM-DD.
		tag.AddTextFrame("TDRC", id3v2.EncodingUTF8, t.RecordingDate)
	}
	if t.Year != "" {
		// TYER is officially v2.3 only, but most players still read it; cheap insurance.
		tag.SetYear(t.Year)
	}
	if t.Genre != "" {
		tag.SetGenre(t.Genre)
	}
	if t.Language != "" {
		tag.AddTextFrame("TLAN", id3v2.EncodingUTF8, t.Language)
	}
	if t.Comment != "" {
		tag.AddCommentFrame(id3v2.CommentFrame{
			Encoding:    id3v2.EncodingUTF8,
			Language:    languageOr(t.Language, "eng"),
			Description: "",
			Text:        t.Comment,
		})
	}
	if t.TrackID != "" {
		tag.AddUserDefinedTextFrame(id3v2.UserDefinedTextFrame{
			Encoding:    id3v2.EncodingUTF8,
			Description: "track_id",
			Value:       t.TrackID,
		})
	}

	if err := tag.Save(); err != nil {
		return fmt.Errorf("id3v2 save %s: %w", mp3Path, err)
	}
	return nil
}

// languageOr returns the ISO-639-2 (3-letter) code expected by COMM frames.
// Our catalog uses ISO-639-1 (2-letter ru/en); map the few we ship.
func languageOr(iso639_1, fallback string) string {
	switch iso639_1 {
	case "ru":
		return "rus"
	case "en":
		return "eng"
	}
	return fallback
}

var _ tagger.Tagger = (*Tagger)(nil)
