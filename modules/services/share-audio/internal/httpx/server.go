package httpx

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/cors"

	"github.com/akdasa-studios/lectorium-share-audio/internal/logx"
	"github.com/akdasa-studios/lectorium-share-audio/internal/pipeline"
)

// buildSHA / buildTime — set by the image build (Dockerfile ARG → ENV).
// Empty in local-dev binaries.
var (
	buildSHA  = os.Getenv("LECTORIUM_BUILD_SHA")
	buildTime = os.Getenv("LECTORIUM_BUILD_TIME")
)

// Max JSON body for /excerpts. Same surface as FastAPI's default — small
// bodies only (we only accept four scalar fields).
const maxBodyBytes = 32 * 1024

type Server struct {
	Cutter     pipeline.Cutter
	Dispatcher *Dispatcher
}

// Router returns a chi router with the CORS middleware preconfigured.
// Outer middlewares (request-id, recoverer) are wired by main so it can
// pass the base logger explicitly.
func (s *Server) Router() http.Handler {
	r := chi.NewRouter()
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"*"},
		AllowedMethods:   []string{"POST", "OPTIONS"},
		AllowedHeaders:   []string{"Content-Type"},
		AllowCredentials: false,
		MaxAge:           600,
	}))
	r.Get("/healthz", s.healthz)
	r.Post("/excerpts", s.postExcerpt)
	return r
}

func (s *Server) healthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status": "ok",
		"build": map[string]string{
			"sha":  buildSHA,
			"time": buildTime,
		},
	})
}

type excerptBody struct {
	SourceKey string `json:"source_key"`
	StartMs   int64  `json:"start_ms"`
	EndMs     int64  `json:"end_ms"`
	ExcerptID string `json:"excerpt_id,omitempty"`
}

func (s *Server) postExcerpt(w http.ResponseWriter, r *http.Request) {
	var body excerptBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	req := pipeline.Request{
		SourceKey: body.SourceKey,
		StartMs:   body.StartMs,
		EndMs:     body.EndMs,
		ExcerptID: body.ExcerptID,
	}

	// Fast path on the request goroutine: validate + resolve eid +
	// S3 HEAD. Everything heavier (download → ffmpeg → upload) runs
	// later in a background worker so client disconnect doesn't kill
	// the upload.
	prep, err := s.Cutter.Prepare(r.Context(), req)
	if err != nil {
		writePrepareError(w, r, err)
		return
	}

	if prep.Cached {
		writeJSON(w, http.StatusOK, pipeline.Result{
			ExcerptID: prep.ExcerptID,
			URL:       prep.URL,
			Ready:     true,
		})
		return
	}

	// Cold path: kick off the background cut and answer immediately
	// with the predicted URL. Pin the resolved excerpt id onto the
	// request so the worker doesn't roll its own UUID and end up
	// writing to a different key.
	workReq := req
	workReq.ExcerptID = prep.ExcerptID
	s.Dispatcher.Dispatch(prep.ExcerptID, func(ctx context.Context) {
		if _, err := s.Cutter.Cut(ctx, workReq); err != nil {
			logx.From(ctx).Error("async_cut_failed", "excerpt_id", prep.ExcerptID, "err", err.Error())
		}
	})

	writeJSON(w, http.StatusAccepted, pipeline.Result{
		ExcerptID: prep.ExcerptID,
		URL:       prep.URL,
		Ready:     false,
	})
}

func writePrepareError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, pipeline.ErrValidation) {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var sErr *pipeline.ServiceError
	if errors.As(err, &sErr) {
		logx.From(r.Context()).Error("prepare_failed", "err", sErr.Error())
		writeError(w, http.StatusBadGateway, sErr.Error())
		return
	}
	logx.From(r.Context()).Error("prepare_unhandled", "err", err.Error())
	writeError(w, http.StatusInternalServerError, "internal server error")
}

func decodeJSON(r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(nil, r.Body, maxBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		// Empty body → FastAPI returns "field required"; we map to the same
		// shape — caller sees 400 {"detail": "..."}.
		if errors.Is(err, io.EOF) {
			return errEmptyBody
		}
		return err
	}
	return nil
}

var errEmptyBody = errors.New("body must be a JSON object")

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// writeError mirrors FastAPI's {"detail": "<msg>"} shape, NOT the
// {"error": "..."} used by share-video. Mobile clients parse different
// keys per service; keep them distinct.
func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"detail": msg})
}
