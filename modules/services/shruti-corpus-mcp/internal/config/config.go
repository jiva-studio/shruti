// Package config loads shruti-corpus-mcp settings from the environment.
//
// The embedding settings MUST resolve to the same model/dim/prefix the chat
// indexer used to embed the corpus, or query vectors land in a different
// space and retrieval silently degrades. Defaults mirror search-mcp (and thus
// chat's config.py). Postgres + embedding are OPTIONAL — the SQLite-backed
// read tools (verse/document/track/source/author/location) work without them;
// only `search` and `transcript_window` need Postgres.
package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

type Config struct {
	// Addr is the listen address INSIDE the container. Always 0.0.0.0:<port>
	// so it is reachable from the published mapping / reverse proxy.
	Addr string

	// DatabaseURL — Postgres/pgvector for `search` + `transcript_window`.
	// Optional: if empty those two tools return dependency_failed and the
	// rest of the surface still serves.
	DatabaseURL string

	// Embedding — mirrors chat config.py / search-mcp defaults.
	EmbedProvider    string // "openrouter" (default) | "openai"
	EmbedModel       string
	EmbedDim         int
	EmbedQueryPrefix string
	EmbedBaseURL     string
	OpenRouterAPIKey string
	OpenAIAPIKey     string

	// SQLite artifacts. MediaBaseURL is the Bunny pull-zone base used to
	// self-bootstrap the two published SQLite DBs; if empty, the service
	// runs purely against the on-disk LibraryDBPath / CatalogDBPath (must
	// already exist — useful for local dev against the lake artifacts).
	MediaBaseURL    string
	CatalogDir      string
	LibraryDBPath   string
	CatalogDBPath   string
	RefreshInterval time.Duration
}

var supportedDims = map[int]bool{256: true, 768: true, 1024: true, 1536: true}

func Load() (Config, error) {
	c := Config{
		Addr:             env("CORPUS_MCP_ADDR", "0.0.0.0:8087"),
		DatabaseURL:      os.Getenv("DATABASE_URL"),
		EmbedProvider:    env("EMBED_PROVIDER", "openrouter"),
		EmbedModel:       env("EMBED_MODEL", "openai/text-embedding-3-small"),
		EmbedQueryPrefix: os.Getenv("EMBED_QUERY_PREFIX"),
		EmbedBaseURL:     os.Getenv("EMBED_BASE_URL"),
		OpenRouterAPIKey: os.Getenv("OPENROUTER_API_KEY"),
		OpenAIAPIKey:     os.Getenv("OPENAI_API_KEY"),
		MediaBaseURL:     os.Getenv("MEDIA_BASE_URL"),
		CatalogDir:       env("CATALOG_DIR", "/var/lib/corpus-mcp"),
	}

	dim, err := strconv.Atoi(env("EMBED_DIM", "1536"))
	if err != nil {
		return Config{}, fmt.Errorf("EMBED_DIM must be an integer: %w", err)
	}
	if !supportedDims[dim] {
		return Config{}, fmt.Errorf("EMBED_DIM=%d unsupported (have chunk_embeddings_d{256,768,1024,1536})", dim)
	}
	c.EmbedDim = dim

	c.LibraryDBPath = env("LIBRARY_DB_PATH", filepath.Join(c.CatalogDir, "library.db"))
	c.CatalogDBPath = env("CATALOG_DB_PATH", filepath.Join(c.CatalogDir, "current.db"))

	ri, err := time.ParseDuration(env("CORPUS_REFRESH_INTERVAL", "15m"))
	if err != nil {
		return Config{}, fmt.Errorf("CORPUS_REFRESH_INTERVAL: %w", err)
	}
	c.RefreshInterval = ri

	// Embedding provider sanity — only enforced when a key is present; a
	// blank provider config just disables search (SearchEnabled()==false).
	switch c.EmbedProvider {
	case "openrouter", "openai":
	default:
		return Config{}, fmt.Errorf("EMBED_PROVIDER=%q unsupported (openrouter|openai)", c.EmbedProvider)
	}
	return c, nil
}

// EmbedConfigured reports whether the embedder has a usable credential/endpoint.
func (c Config) EmbedConfigured() bool {
	switch c.EmbedProvider {
	case "openrouter":
		return c.OpenRouterAPIKey != ""
	case "openai":
		return c.OpenAIAPIKey != "" || c.EmbedBaseURL != ""
	}
	return false
}

// SearchEnabled reports whether semantic search / transcript_window can run.
func (c Config) SearchEnabled() bool {
	return c.DatabaseURL != "" && c.EmbedConfigured()
}

// ChunkTable is the per-dim embedding table for the active dimension.
func (c Config) ChunkTable() string {
	return fmt.Sprintf("chunk_embeddings_d%d", c.EmbedDim)
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
