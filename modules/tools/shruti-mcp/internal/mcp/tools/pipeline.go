package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/application/runner"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/application/runpipeline"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/pipeline"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/run"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/mcp/envelope"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/worker"
)

// pipeline_run is the single async dispatcher for selector-driven work.
//
// `op` chooses the kind of work:
//
//	pipeline       (default) — linear ingest→committed pipeline. Honours
//	                           from / only / up_to / force / review_models.
//	audio_tag      — re-tag mp3 ID3 tags for matched (track, language) pairs.
//	align_pdf      — run PDF→ASR aligner; auto-narrows has_pdf=true.
//	audit          — corpus health walk; aggregator output lives in run.Result.
//	titles_refresh — LLM-rederive titles for matched (track, language) pairs.
//
// Per-stage re-run on a selector:
//
//	only=<stage>           run exactly that stage (cascade-resets dependents,
//	                       rolls back commits if upstream of committed).
//	from=<stage> up_to=<Y> run the stage range, same reset semantics.
//
// only=ingested is rejected (re-ingesting re-hashes the file → mints a new
// track_id → orphans every catalog row; pass force=true with a fresh path
// instead).
func RegisterPipelineRun(s *server.MCPServer, deps Deps) {
	const kind = "pipeline.run"
	tool := mcp.NewTool(kind,
		mcp.WithDescription(
			"Selector-driven async dispatcher. op=pipeline (default) runs the linear "+
				"ingest→committed pipeline. op=audio_tag / align_pdf / audit / titles_refresh "+
				"are post-commit / cross-cutting operations. Per-stage re-run on a selector: "+
				"only=<stage> wipes that stage + dependents and runs only it; "+
				"from=<stage> up_to=<Y> resets stage X and runs through Y. "+
				"only=ingested is rejected (re-hash mints a new track_id). "+
				"Returns a run_id; monitor via run_status / run_wait."),
		mcp.WithObject("selector", mcp.Description(
			"track.Selector — see tracks_select for the full schema. Empty "+
				"object selects everything in the lake + registry up to limit.")),
		mcp.WithString("op", mcp.Description("Operation: pipeline (default) | audio_tag | align_pdf | audit | titles_refresh.")),
		mcp.WithBoolean("force", mcp.Description("op=pipeline only: reset all stages of the touched tracks before running.")),
		mcp.WithString("up_to", mcp.Description("op=pipeline only: stop after this stage. Values: ingested, normalized, metadata, transcribed, reviewed, committed (default).")),
		mcp.WithString("from", mcp.Description("op=pipeline only: starting stage. Mutually exclusive with only. Resets the named stage + dependents to Pending before running.")),
		mcp.WithString("only", mcp.Description("op=pipeline only: re-run exactly this stage (resets stage + dependents + rolls back commits if upstream of committed). Mutually exclusive with from / up_to. only=ingested is rejected.")),
		mcp.WithString("review_models", mcp.Description("op=pipeline only: comma-separated list of review model aliases overriding config defaults.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if deps.Runner == nil {
			return envelope.Err(kind, envelope.CodeInternal, "runner not initialized", nil), nil
		}

		// op default: pipeline.
		op := pipeline.Op(req.GetString("op", string(pipeline.OpPipeline)))
		if !pipeline.IsValidOp(op) {
			return envelope.Err(kind, envelope.CodeInvalidArgument,
				fmt.Sprintf("op %q invalid; allowed: pipeline | audio_tag | align_pdf | audit | titles_refresh", op),
				nil), nil
		}

		sel, err := parseSelector(req)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}

		switch op {
		case pipeline.OpPipeline:
			return dispatchPipeline(ctx, deps, kind, sel, req)
		case pipeline.OpAudioTag:
			return dispatchAudioTag(ctx, deps, kind, sel)
		case pipeline.OpAlignPDF:
			return dispatchAlignPDF(ctx, deps, kind, sel)
		case pipeline.OpAudit:
			return dispatchAudit(ctx, deps, kind, sel, req)
		case pipeline.OpTitlesRefresh:
			return dispatchTitlesRefresh(ctx, deps, kind, sel)
		}
		return envelope.Err(kind, envelope.CodeInternal, "unreachable op switch", nil), nil
	})
}

// dispatchPipeline is the linear ingest→committed work. Resolves the
// selector, queues every match into the worker pool, registers an
// aggregator run that polls per-target progress.
func dispatchPipeline(ctx context.Context, deps Deps, kind string, sel selectorDomain, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if deps.Pool == nil {
		return envelope.Err(kind, envelope.CodeInternal, "worker pool not initialized", nil), nil
	}

	opts := runpipeline.Options{
		Force:        req.GetBool("force", false),
		UpTo:         pipeline.Stage(req.GetString("up_to", "")),
		From:         pipeline.Stage(req.GetString("from", "")),
		Only:         pipeline.Stage(req.GetString("only", "")),
		ReviewModels: parseModelsCSV(req.GetString("review_models", "")),
	}

	if opts.Only != "" && (opts.From != "" || opts.UpTo != "") {
		return envelope.Err(kind, envelope.CodeInvalidArgument,
			"only is mutually exclusive with from / up_to", nil), nil
	}
	if opts.Only == pipeline.StageIngested {
		return envelope.Err(kind, envelope.CodeInvalidArgument,
			"only=ingested is destructive (re-ingest re-hashes the file → mints a new track_id → orphans every catalog row). Use force=true and supply a fresh path instead.",
			nil), nil
	}

	rows, err := deps.SelectTracks.Run(ctx, sel.Selector)
	if err != nil {
		return envelope.Err(kind, envelope.CodeInternal, "resolve selector: "+err.Error(), nil), nil
	}

	type rejected struct {
		Path  string `json:"path"`
		Error string `json:"error"`
	}
	accepted := make([]string, 0, len(rows))
	var rejList []rejected
	for _, r := range rows {
		// Eagerly reset the target stage row(s) BEFORE queueing worker
		// items. The worker itself also resets (idempotently) inside
		// Run(), but the dispatcher snapshot below reads the registry to
		// decide when to stop polling — without an eager reset the
		// snapshot fires before any worker has started and sees the
		// pre-reset "all done" state, terminating instantly. Idempotent;
		// errors here are logged via the worker's later attempt.
		if (opts.Only != "" || opts.From != "") && r.TrackId != "" {
			stage := opts.Only
			if stage == "" {
				stage = opts.From
			}
			key := pipeline.Key{Stage: stage}
			if !stage.LanguageAgnostic() {
				key.Variant = r.Language
			}
			_ = deps.Registry.ResetStageAndDependents(ctx, r.TrackId, key)
		}
		if err := deps.Pool.Submit(ctx, worker.Item{Path: r.Path, Opts: opts}); err != nil {
			rejList = append(rejList, rejected{Path: r.Path, Error: err.Error()})
			continue
		}
		accepted = append(accepted, r.Path)
	}

	selSnapshot := sel.Selector
	runId, err := deps.Runner.Submit(ctx, runner.Spec{
		Kind: run.KindPipeline,
		Init: run.Run{
			Selector: &selSnapshot,
			Targets:  append([]string{}, accepted...),
			Progress: run.Progress{FilesTotal: len(accepted)},
		},
		Cancellable: false,
		WorkFn: func(workCtx context.Context, report runner.ProgressFn) (json.RawMessage, error) {
			if len(accepted) == 0 {
				body, _ := json.Marshal(struct {
					Accepted []string   `json:"accepted"`
					Rejected []rejected `json:"rejected,omitempty"`
				}{[]string{}, rejList})
				return body, nil
			}
			target := opts.UpTo
			if target == "" {
				// only=<stage> tells the worker to re-run exactly one stage —
				// without this branch the dispatcher would wait for tracks to
				// reach StageCommitted, which the worker is not running, and
				// loop forever.
				if opts.Only != "" {
					target = opts.Only
				} else {
					target = pipeline.StageCommitted
				}
			}
			deadline := time.NewTicker(3 * time.Second)
			defer deadline.Stop()
			done := atomic.Int64{}
			failed := atomic.Int64{}
			// Skip the early-exit check on the first iteration when a stage
			// reset is expected (only / from / force). Pool.Submit dispatches
			// work asynchronously; if the snapshot fires before any worker
			// has reset the target stage to Pending, it will read the
			// pre-reset "all done" state and exit immediately, leaving the
			// actual review work to run unobserved.
			expectsReset := opts.Only != "" || opts.From != "" || opts.Force
			for i := 0; ; i++ {
				d, f, breakdown := pipelineProgressSnapshot(workCtx, deps, accepted, target)
				done.Store(int64(d))
				failed.Store(int64(f))
				report(run.Progress{
					FilesTotal:     len(accepted),
					FilesDone:      d,
					FilesFailed:    f,
					StageBreakdown: breakdown,
				})
				if !(expectsReset && i == 0) && d+f >= len(accepted) {
					break
				}
				select {
				case <-workCtx.Done():
					return nil, workCtx.Err()
				case <-deadline.C:
				}
			}
			body, _ := json.Marshal(struct {
				Accepted []string   `json:"accepted"`
				Done     int        `json:"done"`
				Failed   int        `json:"failed"`
				Rejected []rejected `json:"rejected,omitempty"`
			}{accepted, int(done.Load()), int(failed.Load()), rejList})
			return body, nil
		},
	})
	if err != nil {
		return envelope.Err(kind, envelope.CodeInternal, "submit run: "+err.Error(), nil), nil
	}

	rejInline := make([]any, 0, len(rejList))
	for i, r := range rejList {
		if i >= 20 {
			break
		}
		rejInline = append(rejInline, r)
	}
	return envelope.Run(kind, runDispatch{
		Id:            runId,
		Kind:          string(run.KindPipeline),
		State:         "queued",
		AcceptedCount: len(accepted),
		RejectedCount: len(rejList),
		Rejected:      rejInline,
	}), nil
}

// pipelineProgressSnapshot walks the registry for each accepted target
// and tallies how many have reached the requested up_to stage (or
// committed when up_to was empty), how many failed at any stage, and
// the per-stage breakdown.
func pipelineProgressSnapshot(ctx context.Context, deps Deps, paths []string, target pipeline.Stage) (done, failed int, breakdown map[string]int) {
	breakdown = map[string]int{}
	stageRank := map[pipeline.Stage]int{
		pipeline.StageIngested:          1,
		pipeline.StageNormalized:        2,
		pipeline.StageMetadataExtracted: 3,
		pipeline.StageTranscribed:       4,
		pipeline.StageReviewed:          5,
		pipeline.StageCommitted:         6,
	}
	targetRank := stageRank[target]
	for _, p := range paths {
		id, ok, err := deps.Registry.LookupByPath(ctx, p)
		if err != nil || !ok {
			continue
		}
		stages, err := deps.Registry.ListAllStages(ctx, id)
		if err != nil {
			continue
		}
		hadFailure := false
		bestRank := 0
		for _, sr := range stages {
			if sr.Status == pipeline.StatusFailed {
				hadFailure = true
			}
			if sr.Status == pipeline.StatusDone {
				breakdown[string(sr.Key.Stage)]++
				if r := stageRank[sr.Key.Stage]; r > bestRank {
					bestRank = r
				}
			}
		}
		switch {
		case hadFailure:
			failed++
		case targetRank > 0 && bestRank >= targetRank:
			done++
		}
	}
	return
}

func normalizePath(inDir, p string) string {
	if filepath.IsAbs(p) {
		return p
	}
	return filepath.Join(inDir, p)
}

func RegisterAll(s *server.MCPServer, deps Deps) {
	RegisterTracksSelect(s, deps)
	RegisterTrackIngest(s, deps)
	RegisterTrackStatus(s, deps)
	RegisterAudioNormalize(s, deps)
	RegisterMetadataExtract(s, deps)
	RegisterTranscriptCreate(s, deps)
	RegisterTranscriptReview(s, deps)
	RegisterTranscriptAlignPDF(s, deps)
	RegisterProviderList(s, deps)
	RegisterRunsList(s, deps)
	RegisterRunStatus(s, deps)
	RegisterRunWait(s, deps)
	RegisterRunCancel(s, deps)
	RegisterTrackValidate(s, deps)
	RegisterTrackCommit(s, deps)
	RegisterTrackSetMetadata(s, deps)
	RegisterTrackTagAudio(s, deps)
	RegisterPipelineRun(s, deps)
	RegisterAuditSummary(s, deps)
	RegisterAuditTrack(s, deps)
	RegisterDictCRUD(s, deps.DictCRUD)
	RegisterCollectionCRUD(s, deps.CollectionCRUD)
	RegisterCollectionGroupCRUD(s, deps.CollectionGroupCRUD)
	RegisterAuthorProfile(s, deps.AuthorProfile)
	RegisterCatalogRefresh(s, deps.Catalog)
	RegisterCatalogStatus(s, deps.Catalog)
	RegisterCatalogPublish(s, deps)
	RegisterCatalogProactive(s, deps.Proactive)
	RegisterCatalogRegions(s, deps.Regions)
	RegisterConfigPublish(s, deps.ConfigPublish)
	RegisterCatalogReadTools(s, deps.Catalog)
	RegisterDictFinds(s, deps.Find)
	RegisterLibrary(s, deps.Library)
	RegisterLibraryAttribution(s, deps.LibraryAttribution)
	RegisterLibraryImport(s, deps)
	RegisterLibraryPublish(s, deps)
	RegisterAdminConfigGet(s, deps)
	RegisterAdminConfigSet(s, deps)
}
