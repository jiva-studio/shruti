package sqliteregistry

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/pipeline"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
	transcriptport "github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/ports/transcript"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/ports/trackselect"
)

// TrackSelector implements ports/trackselect.Selector on top of the same
// SQLite registry that powers Registry. The registry-side path is a single
// SELECT over `files` joined with `stages`; the lake-side path is a
// filesystem walk of LakeRoot minus paths already in `files`. PDF presence
// and review.json audit metrics are probed on disk per row, lazily.
type TrackSelector struct {
	DB          *sql.DB
	LakeRoot    string // --in (filesystem walk root for SourceLake)
	OutDir      string // out/artifacts/.../transcript.pdf, out/artifacts/.../review.json
	Transcripts transcriptport.Store
}

// NewTrackSelector wires a TrackSelector that shares Registry's DB handle.
// Both LakeRoot and OutDir must be set; Transcripts is required for
// AuditMetrics enrichment but the rest of the resolver works without it.
func NewTrackSelector(db *sql.DB, lakeRoot, outDir string, transcripts transcriptport.Store) *TrackSelector {
	return &TrackSelector{DB: db, LakeRoot: lakeRoot, OutDir: outDir, Transcripts: transcripts}
}

// Select resolves sel into Selected rows. See package docs on
// internal/ports/trackselect for semantics.
func (ts *TrackSelector) Select(ctx context.Context, sel track.Selector) ([]trackselect.Selected, error) {
	if sel.Limit <= 0 {
		sel.Limit = track.DefaultLimit
	}
	out := make([]trackselect.Selected, 0, 64)
	knownPaths := map[string]struct{}{}

	if sel.IncludesRegistry() {
		rows, err := ts.selectRegistry(ctx, sel)
		if err != nil {
			return nil, fmt.Errorf("trackselect registry: %w", err)
		}
		for _, r := range rows {
			knownPaths[r.Path] = struct{}{}
			out = append(out, r)
			if len(out) >= sel.Limit {
				return out, nil
			}
		}
	}
	if sel.IncludesLake() {
		rows, err := ts.selectLake(ctx, sel, knownPaths, sel.Limit-len(out))
		if err != nil {
			return nil, fmt.Errorf("trackselect lake: %w", err)
		}
		out = append(out, rows...)
	}
	return out, nil
}

// selectRegistry SELECTs from `files` joined with stages and applies all
// filters that translate cleanly to SQL. Filters that need disk reads
// (HasPDF, AuditFallback, LowConfMinSegs, KindTags) are applied as
// post-filters in Go after the SQL pass — gating in SQL would either
// require json_extract over stage payloads or an os.Stat per candidate
// inside a query, neither of which is friendlier than just looping after
// the rows are in memory.
func (ts *TrackSelector) selectRegistry(ctx context.Context, sel track.Selector) ([]trackselect.Selected, error) {
	q := strings.Builder{}
	q.WriteString(`SELECT f.path, f.track_id, f.language, f.size_bytes, f.ingested_at FROM files f`)

	args := []any{}
	where := []string{}

	if len(sel.Languages) > 0 {
		placeholders := make([]string, len(sel.Languages))
		for i, lang := range sel.Languages {
			placeholders[i] = "?"
			args = append(args, lang)
		}
		where = append(where, "f.language IN ("+strings.Join(placeholders, ",")+")")
	}
	if len(sel.TrackIds) > 0 {
		placeholders := make([]string, len(sel.TrackIds))
		for i, id := range sel.TrackIds {
			placeholders[i] = "?"
			args = append(args, id)
		}
		where = append(where, "f.track_id IN ("+strings.Join(placeholders, ",")+")")
	}
	if sel.PathPrefix != "" {
		// PathPrefix is relative to LakeRoot. Match on the absolute path.
		where = append(where, "f.path LIKE ?")
		args = append(args, filepath.Join(ts.LakeRoot, sel.PathPrefix)+"%")
	}
	if sel.SizeMin > 0 {
		where = append(where, "f.size_bytes >= ?")
		args = append(args, sel.SizeMin)
	}
	if sel.SizeMax > 0 {
		where = append(where, "f.size_bytes <= ?")
		args = append(args, sel.SizeMax)
	}
	if !sel.DiscoveredAfter.IsZero() {
		where = append(where, "f.ingested_at >= ?")
		args = append(args, sel.DiscoveredAfter.UTC().Format(time.RFC3339))
	}
	if !sel.DiscoveredBefore.IsZero() {
		where = append(where, "f.ingested_at <= ?")
		args = append(args, sel.DiscoveredBefore.UTC().Format(time.RFC3339))
	}
	for stage, status := range sel.StageStatus {
		// Match on EXISTS so multiple stage_status entries can AND together.
		where = append(where, `EXISTS (SELECT 1 FROM stages s WHERE s.track_id = f.track_id AND s.stage = ? AND s.status = ?)`)
		args = append(args, string(stage), string(status))
	}

	if len(where) > 0 {
		q.WriteString(" WHERE ")
		q.WriteString(strings.Join(where, " AND "))
	}
	q.WriteString(" ORDER BY f.ingested_at DESC")
	// We don't apply LIMIT here: LastDoneStage / KindTags / HasPDF /
	// AuditFallback are post-filters and may drop rows; the caller-facing
	// limit is enforced after enrichment.

	rows, err := ts.DB.QueryContext(ctx, q.String(), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]trackselect.Selected, 0, 64)
	for rows.Next() {
		var (
			path        string
			trackId     string
			language    string
			size        int64
			ingestedAt  string
		)
		if err := rows.Scan(&path, &trackId, &language, &size, &ingestedAt); err != nil {
			return nil, err
		}
		t, _ := time.Parse(time.RFC3339, ingestedAt)
		row := trackselect.Selected{
			Path:         path,
			TrackId:      track.Id(trackId),
			Language:     language,
			Size:         size,
			DiscoveredAt: t,
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Post-filter passes — each may both enrich and drop rows.
	out, err = ts.attachStageInfo(ctx, out, sel)
	if err != nil {
		return nil, err
	}
	out = applyPathGlob(out, sel.PathGlob, ts.LakeRoot)
	out = ts.applyHasPDF(out, sel.HasPDF)
	out = ts.applyKindTags(ctx, out, sel.KindTags)

	if sel.EnrichAudit {
		var aerr error
		out, aerr = ts.enrichAudit(ctx, out)
		if aerr != nil {
			return nil, aerr
		}
		out = applyAuditFilters(out, sel.AuditFallback, sel.LowConfMinSegs)
	}

	return out, nil
}

// attachStageInfo computes LastDone for each row and applies the
// LastDoneStage filter. Done in Go (not SQL) because the rank is a
// canonical sequence — encoding it as a CASE expression for every query
// is noisier than a small map lookup per row.
func (ts *TrackSelector) attachStageInfo(ctx context.Context, in []trackselect.Selected, sel track.Selector) ([]trackselect.Selected, error) {
	if len(in) == 0 {
		return in, nil
	}
	stageRank := map[pipeline.Stage]int{
		pipeline.StageIngested:          1,
		pipeline.StageNormalized:        2,
		pipeline.StageMetadataExtracted: 3,
		pipeline.StageTranscribed:       4,
		pipeline.StageReviewed:          5,
		pipeline.StageCommitted:         6,
	}
	for i, row := range in {
		// Single-row query is cheap given the post-LIMIT row count, and
		// keeps the SQL builder above readable.
		stageRows, err := ts.DB.QueryContext(ctx,
			`SELECT stage FROM stages WHERE track_id = ? AND status = ?`,
			string(row.TrackId), string(pipeline.StatusDone))
		if err != nil {
			return nil, err
		}
		var best pipeline.Stage
		bestRank := 0
		for stageRows.Next() {
			var st string
			if err := stageRows.Scan(&st); err != nil {
				stageRows.Close()
				return nil, err
			}
			s := pipeline.Stage(st)
			if r := stageRank[s]; r > bestRank {
				bestRank = r
				best = s
			}
		}
		stageRows.Close()
		if err := stageRows.Err(); err != nil {
			return nil, err
		}
		in[i].LastDone = best
	}

	if sel.LastDoneStage == "" {
		return in, nil
	}
	out := in[:0]
	for _, row := range in {
		if row.LastDone == sel.LastDoneStage {
			out = append(out, row)
		}
	}
	return out, nil
}

func applyPathGlob(in []trackselect.Selected, glob, lakeRoot string) []trackselect.Selected {
	if glob == "" {
		return in
	}
	out := in[:0]
	for _, row := range in {
		rel, _ := filepath.Rel(lakeRoot, row.Path)
		ok, _ := filepath.Match(glob, rel)
		if ok {
			out = append(out, row)
		}
	}
	return out
}

// applyHasPDF probes transcript.pdf on disk for each row when HasPDF is
// set. Cheap: one os.Stat per track, no reads.
func (ts *TrackSelector) applyHasPDF(in []trackselect.Selected, want *bool) []trackselect.Selected {
	if want == nil {
		// Still populate HasPDF as enrichment so the result row carries
		// the truth; just don't filter.
		for i, row := range in {
			in[i].HasPDF = pdfExists(ts.OutDir, row.TrackId)
		}
		return in
	}
	out := in[:0]
	for _, row := range in {
		row.HasPDF = pdfExists(ts.OutDir, row.TrackId)
		if row.HasPDF == *want {
			out = append(out, row)
		}
	}
	return out
}

// applyKindTags reads the metadata stage payload off the registry to fill
// KindTag and (when KindTags is set) filter to that subset. metadata is
// language-agnostic — variant=''.
func (ts *TrackSelector) applyKindTags(ctx context.Context, in []trackselect.Selected, want []string) []trackselect.Selected {
	if len(in) == 0 {
		return in
	}
	wantSet := map[string]struct{}{}
	for _, t := range want {
		wantSet[t] = struct{}{}
	}
	out := in[:0]
	for _, row := range in {
		var payload sql.NullString
		err := ts.DB.QueryRowContext(ctx,
			`SELECT payload_json FROM stages WHERE track_id = ? AND stage = ? AND variant = '' AND status = ?`,
			string(row.TrackId), string(pipeline.StageMetadataExtracted), string(pipeline.StatusDone)).
			Scan(&payload)
		if err == nil && payload.Valid {
			var p struct {
				KindTag string `json:"kind_tag"`
			}
			if json.Unmarshal([]byte(payload.String), &p) == nil {
				row.KindTag = p.KindTag
			}
		}
		if len(wantSet) == 0 {
			out = append(out, row)
			continue
		}
		if _, ok := wantSet[row.KindTag]; ok {
			out = append(out, row)
		}
	}
	return out
}

// enrichAudit reads review.json for each (track, language) and tallies
// the audit metrics. Skipped when EnrichAudit=false. Tracks without a
// review.json get zero metrics, not a removal — the audit filters
// downstream decide whether zero counts as exclusion.
func (ts *TrackSelector) enrichAudit(ctx context.Context, in []trackselect.Selected) ([]trackselect.Selected, error) {
	if ts.Transcripts == nil {
		return in, nil
	}
	for i, row := range in {
		if row.TrackId == "" || row.Language == "" {
			continue
		}
		body, err := ts.Transcripts.ReadReviewSession(ctx, row.TrackId, row.Language)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, err
		}
		var session struct {
			FallbackChunks    []int `json:"fallback_chunks"`
			FallbackIdx       []int `json:"fallback_idx"`
			LowConfChunks     []int `json:"low_conf_chunks"`
			NoiseFiltered     []int `json:"noise_filtered_idx"`
			ChunkCount        int   `json:"chunk_count"`
		}
		if err := json.Unmarshal(body, &session); err != nil {
			continue
		}
		in[i].AuditCount = trackselect.AuditMetrics{
			FallbackChunks:    countMax(len(session.FallbackChunks), len(session.FallbackIdx)),
			LowConfidenceSegs: len(session.LowConfChunks),
			NoiseFilteredSegs: len(session.NoiseFiltered),
			TotalChunks:       session.ChunkCount,
		}
	}
	return in, nil
}

func applyAuditFilters(in []trackselect.Selected, fallback *track.FallbackSpec, lowConfMinSegs int) []trackselect.Selected {
	if fallback == nil && lowConfMinSegs <= 0 {
		return in
	}
	out := in[:0]
	for _, row := range in {
		if fallback != nil && row.AuditCount.FallbackChunks < fallback.MinChunks {
			continue
		}
		if lowConfMinSegs > 0 && row.AuditCount.LowConfidenceSegs < lowConfMinSegs {
			continue
		}
		out = append(out, row)
	}
	return out
}

// selectLake walks LakeRoot for *.mp3 files not present in `files`. Lake
// rows return with the registry-side fields zero (TrackId, LastDone,
// KindTag, HasPDF stay empty / false). PathGlob, PathPrefix, SizeMin/Max
// still apply.
func (ts *TrackSelector) selectLake(ctx context.Context, sel track.Selector, known map[string]struct{}, room int) ([]trackselect.Selected, error) {
	if room <= 0 {
		return nil, nil
	}
	if ts.LakeRoot == "" {
		return nil, nil
	}
	// Pull the registered absolute paths once so we can dedup the walk
	// against them in O(1).
	registered := map[string]struct{}{}
	for k := range known {
		registered[k] = struct{}{}
	}
	rows, err := ts.DB.QueryContext(ctx, `SELECT path FROM files`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			rows.Close()
			return nil, err
		}
		registered[p] = struct{}{}
	}
	rows.Close()

	prefix := ""
	if sel.PathPrefix != "" {
		prefix = filepath.Join(ts.LakeRoot, sel.PathPrefix)
	}

	out := make([]trackselect.Selected, 0, room)
	walkErr := filepath.WalkDir(ts.LakeRoot, func(p string, d fs.DirEntry, werr error) error {
		if werr != nil {
			return werr
		}
		if d.IsDir() {
			// Same outbox/duplicates skip rule lake_scan used.
			if d.Name() == "duplicates" && strings.Contains(filepath.ToSlash(p), "/outbox/duplicates") {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.EqualFold(filepath.Ext(p), ".mp3") {
			return nil
		}
		if _, dup := registered[p]; dup {
			return nil
		}
		if prefix != "" && !strings.HasPrefix(p, prefix) {
			return nil
		}
		if sel.PathGlob != "" {
			rel, _ := filepath.Rel(ts.LakeRoot, p)
			ok, _ := filepath.Match(sel.PathGlob, rel)
			if !ok {
				return nil
			}
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if sel.SizeMin > 0 && info.Size() < sel.SizeMin {
			return nil
		}
		if sel.SizeMax > 0 && info.Size() > sel.SizeMax {
			return nil
		}
		row := trackselect.Selected{
			Path:         p,
			Language:     deriveLanguageFromPath(p),
			Size:         info.Size(),
			DiscoveredAt: info.ModTime(),
		}
		if len(sel.Languages) > 0 {
			matched := false
			for _, l := range sel.Languages {
				if l == row.Language {
					matched = true
					break
				}
			}
			if !matched {
				return nil
			}
		}
		out = append(out, row)
		if len(out) >= room {
			return fs.SkipAll
		}
		return nil
	})
	if walkErr != nil {
		return nil, walkErr
	}
	// Stable order: by path. Walk order is filesystem-dependent.
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, nil
}

// deriveLanguageFromPath mirrors the dedup-tool's outbox/sorted/<lang>/
// convention — same heuristic the registry uses on ingest.
func deriveLanguageFromPath(p string) string {
	s := filepath.ToSlash(p)
	switch {
	case strings.Contains(s, "/outbox/sorted/ru/"):
		return "ru"
	case strings.Contains(s, "/outbox/sorted/en/"):
		return "en"
	case strings.Contains(s, "/outbox/sorted/hi/"):
		return "hi"
	}
	return ""
}

func pdfExists(outDir string, id track.Id) bool {
	if id == "" {
		return false
	}
	_, err := os.Stat(filepath.Join(outDir, "artifacts", "tracks", string(id), "transcript.pdf"))
	return err == nil
}

func countMax(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// Compile-time check.
var _ trackselect.Selector = (*TrackSelector)(nil)
