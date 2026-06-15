package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/mark3labs/mcp-go/mcp"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/auditreview"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/runner"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/run"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/mcp/envelope"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/trackselect"
)

// selectorDomain wraps the parsed selector + a copy retained for the
// run record. Centralised so every op-dispatch handler in pipeline.go
// shares the parse path.
type selectorDomain struct {
	Selector track.Selector
}

// parseSelector decodes the selectorJSON arg into a domain Selector.
// Returns an error suitable for envelope.Err with CodeInvalidArgument.
func parseSelector(req mcp.CallToolRequest) (selectorDomain, error) {
	var raw selectorJSON
	if obj := req.GetArguments(); obj != nil {
		if v, ok := obj["selector"]; ok && v != nil {
			body, err := json.Marshal(v)
			if err != nil {
				return selectorDomain{}, fmt.Errorf("selector: %w", err)
			}
			if err := json.Unmarshal(body, &raw); err != nil {
				return selectorDomain{}, fmt.Errorf("selector: %w", err)
			}
		}
	}
	sel, err := raw.toDomain()
	if err != nil {
		return selectorDomain{}, err
	}
	return selectorDomain{Selector: sel}, nil
}

// perTrackResult is the canonical row outcome shape for fan-out ops.
type perTrackResult struct {
	Path     string `json:"path"`
	TrackId  string `json:"track_id"`
	Language string `json:"language"`
	OK       bool   `json:"ok"`
	Error    string `json:"error,omitempty"`
}

// fanOutPerTrack runs fn over each row with concurrency cap, returning
// the accumulated per-track outcomes. Lake-only rows (no TrackId) and
// language-less rows are reported as failures with the corresponding
// error string. Used by the op=audio_tag / op=align_pdf / op=titles_refresh
// dispatchers.
func fanOutPerTrack(
	ctx context.Context,
	rows []trackselect.Selected,
	concurrency int,
	fn func(ctx context.Context, id track.Id, lang string) error,
) (results []perTrackResult, ok int, failed int) {
	if concurrency <= 0 {
		concurrency = 4
	}
	results = make([]perTrackResult, 0, len(rows))
	var mu sync.Mutex
	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup

	for _, r := range rows {
		if r.TrackId == "" {
			mu.Lock()
			results = append(results, perTrackResult{Path: r.Path, OK: false, Error: "not ingested"})
			failed++
			mu.Unlock()
			continue
		}
		if r.Language == "" {
			mu.Lock()
			results = append(results, perTrackResult{Path: r.Path, TrackId: string(r.TrackId), OK: false, Error: "language unknown"})
			failed++
			mu.Unlock()
			continue
		}
		select {
		case <-ctx.Done():
			mu.Lock()
			results = append(results, perTrackResult{Path: r.Path, TrackId: string(r.TrackId), Language: r.Language, OK: false, Error: ctx.Err().Error()})
			failed++
			mu.Unlock()
			continue
		default:
		}
		sem <- struct{}{}
		wg.Add(1)
		go func(r trackselect.Selected) {
			defer wg.Done()
			defer func() { <-sem }()
			err := fn(ctx, r.TrackId, r.Language)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				results = append(results, perTrackResult{Path: r.Path, TrackId: string(r.TrackId), Language: r.Language, OK: false, Error: err.Error()})
				failed++
				return
			}
			results = append(results, perTrackResult{Path: r.Path, TrackId: string(r.TrackId), Language: r.Language, OK: true})
			ok++
		}(r)
	}
	wg.Wait()
	return
}

// submitFanOutRun is the shared dispatch path for op=audio_tag /
// align_pdf / titles_refresh. Snapshots the selector + accepted (track,
// lang) pairs as the run.Targets, kicks a runner.Submit whose WorkFn
// runs fanOutPerTrack and returns the accumulated outcomes as the
// run.Result.
func submitFanOutRun(
	ctx context.Context,
	deps Deps,
	envKind string,
	runKind run.Kind,
	sel selectorDomain,
	work func(ctx context.Context, id track.Id, lang string) error,
) (*mcp.CallToolResult, error) {
	rows, err := deps.SelectTracks.Run(ctx, sel.Selector)
	if err != nil {
		return envelope.Err(envKind, envelope.CodeInternal, "resolve selector: "+err.Error(), nil), nil
	}

	// Snapshot the targets (path list) up front for run.Targets visibility.
	targets := make([]string, 0, len(rows))
	for _, r := range rows {
		targets = append(targets, r.Path)
	}

	selSnapshot := sel.Selector
	runId, err := deps.Runner.Submit(ctx, runner.Spec{
		Kind: runKind,
		Init: run.Run{
			Selector: &selSnapshot,
			Targets:  targets,
			Progress: run.Progress{FilesTotal: len(rows)},
		},
		Cancellable: false,
		WorkFn: func(workCtx context.Context, report runner.ProgressFn) (json.RawMessage, error) {
			results, okCount, failed := fanOutPerTrack(workCtx, rows, 4, work)
			report(run.Progress{
				FilesTotal:  len(rows),
				FilesDone:   okCount,
				FilesFailed: failed,
			})
			body, _ := json.Marshal(struct {
				Total   int              `json:"total"`
				OK      int              `json:"ok"`
				Failed  int              `json:"failed"`
				Results []perTrackResult `json:"results"`
			}{len(rows), okCount, failed, results})
			return body, nil
		},
	})
	if err != nil {
		return envelope.Err(envKind, envelope.CodeInternal, "submit run: "+err.Error(), nil), nil
	}
	return envelope.Run(envKind, runDispatch{
		Id:            runId,
		Kind:          string(runKind),
		State:         "queued",
		AcceptedCount: len(rows),
	}), nil
}

// dispatchAudioTag handles op=audio_tag — re-tag mp3 ID3 for matched (track, lang) pairs.
func dispatchAudioTag(ctx context.Context, deps Deps, kind string, sel selectorDomain) (*mcp.CallToolResult, error) {
	return submitFanOutRun(ctx, deps, kind, run.KindAudioTag, sel,
		func(ctx context.Context, id track.Id, lang string) error {
			_, err := deps.AudioTag.Run(ctx, id, lang)
			return err
		})
}

// dispatchAlignPDF handles op=align_pdf — runs PDF→ASR aligner.
// Auto-narrows has_pdf=true; rejects explicit has_pdf=false as a conflict.
func dispatchAlignPDF(ctx context.Context, deps Deps, kind string, sel selectorDomain) (*mcp.CallToolResult, error) {
	if sel.Selector.HasPDF != nil && !*sel.Selector.HasPDF {
		return envelope.Err(kind, envelope.CodeInvalidArgument,
			"op=align_pdf cannot run with has_pdf=false (it's a PDF-only operation)", nil), nil
	}
	t := true
	sel.Selector.HasPDF = &t
	return submitFanOutRun(ctx, deps, kind, run.KindAlignPDF, sel,
		func(ctx context.Context, id track.Id, lang string) error {
			_, err := deps.AlignPDF.Run(ctx, id, lang)
			return err
		})
}

// dispatchTitlesRefresh handles op=titles_refresh — LLM-rederive titles.
func dispatchTitlesRefresh(ctx context.Context, deps Deps, kind string, sel selectorDomain) (*mcp.CallToolResult, error) {
	return submitFanOutRun(ctx, deps, kind, run.KindTitlesRefresh, sel,
		func(ctx context.Context, id track.Id, lang string) error {
			_, err := deps.RefreshTitle.Run(ctx, id, lang)
			return err
		})
}

// dispatchOutline handles op=outline — generate the outline + description for
// matched (track, language) pairs and write them onto the catalog variant.
func dispatchOutline(ctx context.Context, deps Deps, kind string, sel selectorDomain) (*mcp.CallToolResult, error) {
	if deps.Outline.LLM == nil {
		return envelope.Err(kind, envelope.CodeDependencyFailed, "outline generation not configured (set config outline.api_key + outline.model)", nil), nil
	}
	return submitFanOutRun(ctx, deps, kind, run.KindTranscriptOutline, sel,
		func(ctx context.Context, id track.Id, lang string) error {
			_, err := deps.Outline.Run(ctx, id, lang)
			return err
		})
}

// dispatchAudit handles op=audit — corpus walk + aggregator.
// Empty selector = whole corpus. Top-N cap defaults to 50; callers can
// pass a `top` arg.
func dispatchAudit(ctx context.Context, deps Deps, kind string, sel selectorDomain, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var candidates []auditreview.Candidate
	if !selectorIsEmpty(sel.Selector) {
		rows, err := deps.SelectTracks.Run(ctx, sel.Selector)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, "resolve selector: "+err.Error(), nil), nil
		}
		for _, r := range rows {
			if r.TrackId == "" || r.Language == "" {
				continue
			}
			candidates = append(candidates, auditreview.Candidate{
				TrackId:  r.TrackId,
				Language: r.Language,
			})
		}
	}
	top := int(req.GetFloat("top", 50))

	selSnapshot := sel.Selector
	runId, err := deps.Runner.Submit(ctx, runner.Spec{
		Kind: run.KindAudit,
		Init: run.Run{
			Selector: &selSnapshot,
			Progress: run.Progress{FilesTotal: len(candidates)},
		},
		Cancellable: false,
		WorkFn: func(workCtx context.Context, report runner.ProgressFn) (json.RawMessage, error) {
			uc := auditreview.UseCase{
				Registry:    deps.Registry,
				Transcripts: deps.Transcripts,
			}
			res, err := uc.Run(workCtx, auditreview.Options{
				Candidates: candidates,
				Top:        top,
			})
			if err != nil {
				return nil, err
			}
			report(run.Progress{
				FilesTotal: len(candidates),
				FilesDone:  len(candidates),
			})
			body, _ := json.Marshal(res)
			return body, nil
		},
	})
	if err != nil {
		return envelope.Err(kind, envelope.CodeInternal, "submit run: "+err.Error(), nil), nil
	}
	return envelope.Run(kind, runDispatch{
		Id:            runId,
		Kind:          string(run.KindAudit),
		State:         "queued",
		AcceptedCount: len(candidates),
	}), nil
}
