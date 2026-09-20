// Package httpx is the small ops HTTP surface: health, campaign listing,
// and a manual run trigger. Scheduled posting runs in the scheduler, not
// here — these endpoints are for operators and dry checks.
package httpx

import (
	"crypto/subtle"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/jiva-studio/lectorium-social-poster/internal/catalog"
	"github.com/jiva-studio/lectorium-social-poster/internal/config"
	"github.com/jiva-studio/lectorium-social-poster/internal/runner"
)

var (
	buildSHA  = os.Getenv("LECTORIUM_BUILD_SHA")
	buildTime = os.Getenv("LECTORIUM_BUILD_TIME")
)

type Server struct {
	Cfg    *config.Config
	Cat    *catalog.Manager
	Runner *runner.Runner
	Log    *slog.Logger
}

// opsToken guards everything but liveness: /run publishes to the live
// Telegram, VK and Facebook accounts.
var opsToken = strings.TrimSpace(os.Getenv("SOCIAL_POSTER_OPS_TOKEN"))

// requireOpsToken refuses when the token is unset: an unfinished deployment
// must not be the thing that opens a publish endpoint.
func requireOpsToken(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if opsToken == "" {
			writeJSON(w, http.StatusServiceUnavailable,
				map[string]any{"error": "this endpoint requires SOCIAL_POSTER_OPS_TOKEN"})
			return
		}
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if subtle.ConstantTimeCompare([]byte(got), []byte(opsToken)) != 1 {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) Router() http.Handler {
	r := chi.NewRouter()
	r.Get("/healthz", s.healthz)
	r.Group(func(r chi.Router) {
		r.Use(requireOpsToken)
		r.Get("/campaigns", s.listCampaigns)
		r.Post("/run/{name}", s.runCampaign)
	})
	return r
}

func (s *Server) healthz(w http.ResponseWriter, _ *http.Request) {
	versions := map[string]int{}
	for name := range s.Cfg.Catalog.Regions {
		if c := s.Cat.Region(name); c != nil {
			versions[name] = c.Version()
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "ok",
		"build":   map[string]string{"sha": buildSHA, "time": buildTime},
		"catalog": versions,
	})
}

func (s *Server) listCampaigns(w http.ResponseWriter, _ *http.Request) {
	type item struct {
		Name     string   `json:"name"`
		Schedule string   `json:"schedule"`
		Region   string   `json:"region"`
		Content  string   `json:"content"`
		Targets  []string `json:"targets"`
		Enabled  bool     `json:"enabled"`
	}
	out := make([]item, 0, len(s.Cfg.Campaigns))
	for _, c := range s.Cfg.Campaigns {
		out = append(out, item{c.Name, c.Schedule, c.Region, c.Content, c.Targets, c.IsEnabled()})
	}
	writeJSON(w, http.StatusOK, out)
}

// runCampaign triggers one campaign synchronously and returns its report.
// Manual/operator path; scheduled runs go through the scheduler.
func (s *Server) runCampaign(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	rep, err := s.Runner.Run(r.Context(), name)
	if err != nil {
		s.Log.Error("manual_run_failed", "campaign", name, "err", err.Error())
		// The raw error can carry a publisher endpoint, tokens included.
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "run failed", "report": rep})
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
