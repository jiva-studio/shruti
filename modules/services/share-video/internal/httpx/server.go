package httpx

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// Router wires the public routes. The auth middleware is mounted on
// /reels endpoints only — /healthz must stay open for compose probes.
func (s *Server) Router(verifier *JWTVerifier) http.Handler {
	r := chi.NewRouter()
	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	r.Group(func(g chi.Router) {
		g.Use(verifier.RequireAuth)
		g.Post("/reels", s.PostReels)
		g.Get("/reels/{id}", s.GetReels)
	})
	return r
}
