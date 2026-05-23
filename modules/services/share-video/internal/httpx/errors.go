package httpx

import (
	"encoding/json"
	"net/http"
)

// writeJSON encodes v with a Content-Type header. Compact JSON; the
// Node service did the same.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// writeError mirrors share-video's existing `{"error": "..."}` shape.
// Mobile clients key on this field — do NOT switch to `{"detail"}`
// (that's the share-audio FastAPI convention).
func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
