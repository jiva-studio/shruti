// Package handler wires the analytics HTTP surface.
package handler

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/lectorium/analytics/internal/cache"
	"github.com/jiva-studio/lectorium/analytics/internal/reports"
)

// buildSHA / buildTime — populated by the image build (Dockerfile ARGs → ENVs).
var (
	buildSHA  = os.Getenv("LECTORIUM_BUILD_SHA")
	buildTime = os.Getenv("LECTORIUM_BUILD_TIME")
)

// RouterDeps bundles everything NewRouter needs.
type RouterDeps struct {
	Pool  *pgxpool.Pool
	Cache *cache.Cache
	// DefaultTTL caps how long any report is cached; a report's own TTL is
	// clamped to it so ops can shorten caching globally via CACHE_TTL.
	DefaultTTL time.Duration
}

// NewRouter wires:
//
//	GET /healthz                         (liveness + build stamp)
//	GET /analytics/reports/{name}?...     (generic report dispatch → JSON)
func NewRouter(d RouterDeps) http.Handler {
	r := chi.NewRouter()
	r.Use(requestLogger)

	r.Get("/healthz", healthz)

	h := &reportsHandler{pool: d.Pool, cache: d.Cache, defaultTTL: d.DefaultTTL}
	r.Get("/analytics/reports/{name}", h.serve)

	return r
}

// envelope is the uniform response shape for every report.
type envelope struct {
	OK          bool           `json:"ok"`
	Report      string         `json:"report"`
	Params      map[string]any `json:"params,omitempty"`
	GeneratedAt int64          `json:"generated_at,omitempty"`
	Cached      bool           `json:"cached"`
	Result      any            `json:"result,omitempty"`
	Error       *errObj        `json:"error,omitempty"`
}

type errObj struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type reportsHandler struct {
	pool       *pgxpool.Pool
	cache      *cache.Cache
	defaultTTL time.Duration
}

func (h *reportsHandler) serve(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	rep, ok := reports.Get(name)
	if !ok {
		writeReportErr(w, name, http.StatusNotFound, "unknown_report", "no such report: "+name)
		return
	}

	// Cache key = report name + normalized (sorted) query string. url.Values
	// Encode sorts by key, so equivalent requests share a cache slot.
	key := name + "?" + r.URL.Query().Encode()
	if e, hit := h.cache.Get(key); hit {
		writeJSON(w, http.StatusOK, envelope{
			OK: true, Report: name, Params: e.Params,
			GeneratedAt: e.GeneratedAt, Cached: true, Result: e.Result,
		})
		return
	}

	result, params, err := rep.Fn(r.Context(), h.pool, r.URL.Query())
	if err != nil {
		var pe *reports.ParamError
		if errors.As(err, &pe) {
			writeReportErr(w, name, http.StatusBadRequest, "invalid_params", pe.Msg)
			return
		}
		slog.ErrorContext(r.Context(), "report_failed", "report", name, "err", err.Error())
		writeReportErr(w, name, http.StatusInternalServerError, "internal", "report computation failed")
		return
	}

	generatedAt := time.Now().UnixMilli()
	if ttl := h.effectiveTTL(rep.TTL); ttl > 0 {
		h.cache.Set(key, cache.Entry{Result: result, Params: params, GeneratedAt: generatedAt}, ttl)
	}

	writeJSON(w, http.StatusOK, envelope{
		OK: true, Report: name, Params: params,
		GeneratedAt: generatedAt, Cached: false, Result: result,
	})
}

// effectiveTTL clamps a report's own TTL to the service-wide cap. A
// DefaultTTL of 0 disables caching entirely (ops kill switch via CACHE_TTL=0).
func (h *reportsHandler) effectiveTTL(reportTTL time.Duration) time.Duration {
	if h.defaultTTL <= 0 {
		return 0
	}
	if reportTTL <= 0 || reportTTL > h.defaultTTL {
		return h.defaultTTL
	}
	return reportTTL
}

func healthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status": "ok",
		"build":  map[string]string{"sha": buildSHA, "time": buildTime},
	})
}

func writeReportErr(w http.ResponseWriter, report string, status int, code, msg string) {
	writeJSON(w, status, envelope{OK: false, Report: report, Error: &errObj{Code: code, Message: msg}})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
