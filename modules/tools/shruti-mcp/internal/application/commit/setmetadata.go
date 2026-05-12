package commit

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	domaincatalog "github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/pipeline"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/track"
	catalogport "github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/ports/catalog"
	lakeport "github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/ports/lake"
)

// SetTrackMetadata is a manual override that patches the metadata-extract
// stage payload (always) and the catalog rows (only after the track is
// already committed). Optional fields use *T so callers can specify "no
// change" by omitting and "unset" by passing empty string.
type SetTrackMetadataInput struct {
	TrackId    track.Id
	Language   string
	AuthorID   *string
	LocationID *string
	Date       *string // YYYY-MM-DD
	Title      *string
	Sources    *[]domaincatalog.TrackReference
}

type SetTrackMetadataUseCase struct {
	Registry lakeport.Registry
	Catalog  catalogport.CommitRepository
}

func (uc SetTrackMetadataUseCase) Run(ctx context.Context, in SetTrackMetadataInput) error {
	if _, err := time.Parse("2006-01-02", strDeref(in.Date, "9999-12-31")); err != nil && in.Date != nil && *in.Date != "" {
		return fmt.Errorf("date must be YYYY-MM-DD: %w", err)
	}

	// 1. Patch the metadata-extract stage payload — this is the source of
	//    truth that track_commit/track_validate read.
	metaKey := pipeline.Key{Stage: pipeline.StageMetadataExtracted}
	stage, ok, err := uc.Registry.GetStage(ctx, in.TrackId, metaKey)
	if err != nil {
		return fmt.Errorf("read metadata stage: %w", err)
	}
	if !ok || len(stage.Payload) == 0 {
		return fmt.Errorf("metadata_extract not run yet for %s — run it first", in.TrackId)
	}
	patched, err := patchMetadataPayload(stage.Payload, in)
	if err != nil {
		return err
	}
	// SetStage(metadata, Done) cascade-resets commit(*) → pending so the next
	// track_commit re-validates against the new payload.
	if err := uc.Registry.SetStage(ctx, in.TrackId, metaKey, pipeline.StatusDone, patched, ""); err != nil {
		return err
	}

	// 2. If the track row already lives in the catalog (post-commit patching),
	//    apply the same change there so consumers see it immediately.
	t, exists, err := uc.Catalog.GetTrack(ctx, string(in.TrackId))
	if err != nil {
		return err
	}
	if !exists {
		return nil
	}
	v, _, err := uc.Catalog.GetVariant(ctx, string(in.TrackId), in.Language)
	if err != nil {
		return err
	}
	if v.TrackID == "" {
		v.TrackID = string(in.TrackId)
		v.Language = in.Language
		v.AudioKind = "edited"
		v.TranscriptKind = "generated"
		v.AudioPath = fmt.Sprintf("public/tracks/%s/audio/original.mp3", string(in.TrackId))
		v.TranscriptPath = fmt.Sprintf("public/tracks/%s/transcripts/%s.json", string(in.TrackId), in.Language)
	}
	if in.AuthorID != nil {
		t.AuthorID = *in.AuthorID
	}
	if in.LocationID != nil {
		t.LocationID = *in.LocationID
	}
	if in.Date != nil {
		t.Date = *in.Date
		t.SortDate = buildSortDate(*in.Date)
	}
	if in.Title != nil {
		v.Title = strings.TrimSpace(*in.Title)
	}
	refs, err := uc.Catalog.GetReferences(ctx, string(in.TrackId))
	if err != nil {
		return err
	}
	if in.Sources != nil {
		refs = *in.Sources
	}
	// Preserve existing kind tags — track_set_metadata doesn't touch them
	// and SaveTrack rewrites the join in full, so we must reload before
	// saving or we'd silently wipe them.
	tagIDs, err := uc.Catalog.GetTrackTags(ctx, string(in.TrackId))
	if err != nil {
		return err
	}
	t.TagIDs = tagIDs

	// Recompute the per-locale by-reference sort key on the variant — same
	// shape as commit.UseCase.Run does (localized short_name as prefix).
	primaryShort := ""
	if len(refs) > 0 {
		entry, ok, _ := uc.Catalog.GetDict(ctx, domaincatalog.KindSource, refs[0].SourceID)
		if ok {
			primaryShort = entry.ShortName[in.Language]
			if primaryShort == "" {
				primaryShort = entry.ShortName["en"]
			}
		}
	}
	v.SortReference = buildSortReference(refs, primaryShort)
	return uc.Catalog.SaveTrack(ctx, t, v, refs)
}

func patchMetadataPayload(raw []byte, in SetTrackMetadataInput) ([]byte, error) {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("parse metadata payload: %w", err)
	}
	if in.AuthorID != nil {
		m["author_id"] = *in.AuthorID
	}
	if in.LocationID != nil {
		m["location_id"] = *in.LocationID
	}
	if in.Date != nil {
		m["date"] = *in.Date
	}
	if in.Title != nil {
		m["title"] = strings.TrimSpace(*in.Title)
		m["title_is_fallback"] = false
	}
	if in.Sources != nil {
		out := make([]map[string]any, 0, len(*in.Sources))
		for _, r := range *in.Sources {
			out = append(out, map[string]any{
				"source_id": r.SourceID,
				"tokens":    r.Tokens,
			})
		}
		m["references"] = out
	}
	return json.Marshal(m)
}

func strDeref(p *string, def string) string {
	if p == nil {
		return def
	}
	return *p
}
