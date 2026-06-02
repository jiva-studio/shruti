// Package config loads shruti-search settings from the environment.
//
// The embedding settings MUST resolve to the same model/dim/prefix the chat
// indexer used to embed the corpus, or query vectors land in a different
// space and retrieval silently degrades. Defaults here mirror
// modules/services/chat/.../config.py exactly; env overrides let a future
// chat model swap propagate to this service with the same variable names.
package config

import (
	"fmt"
	"os"
	"strconv"
)

type Config struct {
	// Addr is the listen address INSIDE the container. Docker publishes it
	// onto the host's tailscale IP via compose `ports:` — the binary itself
	// always binds 0.0.0.0 so it's reachable from the published mapping.
	Addr string

	DatabaseURL string

	// Embedding — mirrors chat config.py defaults.
	EmbedProvider    string // "openrouter" (default) | "openai"
	EmbedModel       string // e.g. "openai/text-embedding-3-small"
	EmbedDim         int    // selects chunk_embeddings_d<dim>; must match indexed vectors
	EmbedQueryPrefix string // empty for text-embedding-3-*; required by e5 family
	EmbedBaseURL     string // override OpenAI-compatible upstream; empty = provider default
	OpenRouterAPIKey string
	OpenAIAPIKey     string
}

// supportedDims mirrors chat embedding_router._SUPPORTED_DIMS — a dim without
// a matching chunk_embeddings_d<dim> table would query a non-existent
// relation, so fail fast at startup instead.
var supportedDims = map[int]bool{256: true, 768: true, 1024: true, 1536: true}

func Load() (Config, error) {
	c := Config{
		Addr:             env("SEARCH_MCP_ADDR", "0.0.0.0:8086"),
		DatabaseURL:      os.Getenv("DATABASE_URL"),
		EmbedProvider:    env("EMBED_PROVIDER", "openrouter"),
		EmbedModel:       env("EMBED_MODEL", "openai/text-embedding-3-small"),
		EmbedQueryPrefix: os.Getenv("EMBED_QUERY_PREFIX"),
		EmbedBaseURL:     os.Getenv("EMBED_BASE_URL"),
		OpenRouterAPIKey: os.Getenv("OPENROUTER_API_KEY"),
		OpenAIAPIKey:     os.Getenv("OPENAI_API_KEY"),
	}

	dim, err := strconv.Atoi(env("EMBED_DIM", "1536"))
	if err != nil {
		return Config{}, fmt.Errorf("EMBED_DIM must be an integer: %w", err)
	}
	if !supportedDims[dim] {
		return Config{}, fmt.Errorf("EMBED_DIM=%d unsupported (have chunk_embeddings_d{256,768,1024,1536})", dim)
	}
	c.EmbedDim = dim

	if c.DatabaseURL == "" {
		return Config{}, fmt.Errorf("DATABASE_URL is required")
	}
	switch c.EmbedProvider {
	case "openrouter":
		if c.OpenRouterAPIKey == "" {
			return Config{}, fmt.Errorf("EMBED_PROVIDER=openrouter requires OPENROUTER_API_KEY")
		}
	case "openai":
		if c.OpenAIAPIKey == "" && c.EmbedBaseURL == "" {
			return Config{}, fmt.Errorf("EMBED_PROVIDER=openai requires OPENAI_API_KEY or EMBED_BASE_URL")
		}
	default:
		return Config{}, fmt.Errorf("EMBED_PROVIDER=%q unsupported (openrouter|openai)", c.EmbedProvider)
	}
	return c, nil
}

// ChunkTable is the per-dim embedding table for the active dimension —
// mirrors chat EmbeddingTableRouter.chunk_table.
func (c Config) ChunkTable() string {
	return fmt.Sprintf("chunk_embeddings_d%d", c.EmbedDim)
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
