package httpx

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/cors"

	"github.com/akdasa-studios/lectorium-share-audio/internal/logx"
	"github.com/akdasa-studios/lectorium-share-audio/internal/pipeline"
)

// Max JSON body for /excerpts. Same surface as FastAPI's default — small
// bodies only (we only accept four scalar fields).
const maxBodyBytes = 32 * 1024

type Server struct {
	Cutter pipeline.Cutter
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
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
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

	res, err := s.Cutter.Cut(r.Context(), pipeline.Request{
		SourceKey: body.SourceKey,
		StartMs:   body.StartMs,
		EndMs:     body.EndMs,
		ExcerptID: body.ExcerptID,
	})
	if err != nil {
		if errors.Is(err, pipeline.ErrValidation) {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		var sErr *pipeline.ServiceError
		if errors.As(err, &sErr) {
			logx.From(r.Context()).Error("cut_failed", "err", sErr.Error())
			writeError(w, http.StatusBadGateway, sErr.Error())
			return
		}
		logx.From(r.Context()).Error("cut_unhandled", "err", err.Error())
		writeError(w, http.StatusInternalServerError, "internal server error")
		return
	}
	writeJSON(w, http.StatusOK, res)
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
