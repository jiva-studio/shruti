package httpx

import (
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"
)

// buildSHA / buildTime — set by the image build (Dockerfile ARG → ENV).
// Empty in local-dev binaries; operators hit /healthz post-deploy to
// confirm Watchtower rolled the new image.
var (
	buildSHA  = os.Getenv("LECTORIUM_BUILD_SHA")
	buildTime = os.Getenv("LECTORIUM_BUILD_TIME")
)

// Router wires the public routes. The auth middleware is mounted on
// /reels endpoints only — /healthz must stay open for compose probes.
func (s *Server) Router(verifier *JWTVerifier) http.Handler {
	r := chi.NewRouter()
	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"status": "ok",
			"build": map[string]string{
				"sha":  buildSHA,
				"time": buildTime,
			},
		})
	})
	r.Group(func(g chi.Router) {
		g.Use(verifier.RequireAuth)
		g.Post("/reels", s.PostReels)
		g.Get("/reels/{id}", s.GetReels)
	})
	return r
}
