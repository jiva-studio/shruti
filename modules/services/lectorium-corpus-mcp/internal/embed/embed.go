// Package embed turns a query string into a dense vector via an
// OpenAI-compatible /embeddings endpoint — the same call the chat indexer
// makes, so query and corpus vectors share one space. Ported verbatim from
// search-mcp.
//
// A best-effort Redis cache (own key namespace) fronts the HTTP call: an
// identical query text re-embeds from cache instead of paying the ~2s API
// round-trip. Redis is entirely optional — any connect/read/write failure
// degrades to a plain API call, never an error.
package embed

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/jiva-studio/lectorium/modules/services/lectorium-corpus-mcp/internal/config"
)

// cacheTTL is how long a cached query embedding survives. Query text → vector
// is stable for a given model, so a long TTL is safe; 30d bounds unbounded
// growth from one-off queries.
const cacheTTL = 30 * 24 * time.Hour

// Client embeds a single query. We only ever embed one string at a time
// (interactive search), so there's no batch path like the indexer's.
type Client struct {
	http     *http.Client
	baseURL  string
	model    string
	apiKey   string
	queryPfx string

	// rdb is the optional query-embedding cache. nil when Redis is
	// unconfigured or unreachable — every cache op tolerates that.
	rdb *redis.Client
}

// New builds the embedder from config, resolving the provider's base URL the
// same way embed.py's _build_embedder does. If a Redis URL is configured and
// reachable, an embedding cache is attached; otherwise the client works
// exactly as before, just without caching.
func New(c config.Config) *Client {
	baseURL := c.EmbedBaseURL
	apiKey := c.OpenAIAPIKey
	if c.EmbedProvider == "openrouter" {
		if baseURL == "" {
			baseURL = "https://openrouter.ai/api/v1"
		}
		apiKey = c.OpenRouterAPIKey
	} else if baseURL == "" {
		baseURL = "https://api.openai.com/v1"
	}
	cl := &Client{
		http:     &http.Client{Timeout: 30 * time.Second},
		baseURL:  baseURL,
		model:    c.EmbedModel,
		apiKey:   apiKey,
		queryPfx: c.EmbedQueryPrefix,
	}
	cl.rdb = dialCache(c.RedisURL)
	return cl
}

// dialCache builds the optional Redis cache client. Any failure (bad URL,
// unreachable, ping timeout) logs a warning and returns nil so the embedder
// falls back to the API-only path.
func dialCache(url string) *redis.Client {
	if url == "" {
		return nil
	}
	opt, err := redis.ParseURL(url)
	if err != nil {
		log.Printf("WARN embed cache disabled, bad REDIS_URL: %v", err)
		return nil
	}
	opt.DialTimeout = 500 * time.Millisecond
	opt.ReadTimeout = 300 * time.Millisecond
	opt.WriteTimeout = 300 * time.Millisecond
	rdb := redis.NewClient(opt)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := rdb.Ping(ctx).Err(); err != nil {
		log.Printf("WARN embed cache disabled, redis ping failed: %v", err)
		_ = rdb.Close()
		return nil
	}
	return rdb
}

type embedRequest struct {
	Model string `json:"model"`
	Input string `json:"input"`
}

type embedResponse struct {
	Data []struct {
		Embedding []float32 `json:"embedding"`
	} `json:"data"`
}

// Query embeds one query string, applying the configured query prefix. Cache
// hits skip the HTTP call; misses embed via the API and populate the cache
// best-effort. Redis errors never fail the query.
func (c *Client) Query(ctx context.Context, text string) ([]float32, error) {
	input := text
	if c.queryPfx != "" {
		input = c.queryPfx + text
	}

	key := c.cacheKey(input)
	if vec, ok := c.cacheGet(ctx, key); ok {
		return vec, nil
	}

	vec, err := c.embedAPI(ctx, input)
	if err != nil {
		return nil, err
	}
	c.cacheSet(ctx, key, vec)
	return vec, nil
}

// embedAPI performs the OpenAI-compatible /embeddings call.
func (c *Client) embedAPI(ctx context.Context, input string) ([]float32, error) {
	body, err := json.Marshal(embedRequest{Model: c.model, Input: input})
	if err != nil {
		return nil, fmt.Errorf("marshal embed request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/embeddings", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build embed request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("embed request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		var buf bytes.Buffer
		_, _ = buf.ReadFrom(resp.Body)
		return nil, fmt.Errorf("embed endpoint %d: %s", resp.StatusCode, buf.String())
	}
	var out embedResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("decode embed response: %w", err)
	}
	if len(out.Data) == 0 || len(out.Data[0].Embedding) == 0 {
		return nil, fmt.Errorf("embed endpoint returned no vector")
	}
	return out.Data[0].Embedding, nil
}

// cacheKey derives the namespaced Redis key from the embedded input. The
// digest is truncated to 16 bytes — ample to avoid collisions for query text.
func (c *Client) cacheKey(input string) string {
	sum := sha256.Sum256([]byte(input))
	return "corpus:embed:v1:" + c.model + ":" + hex.EncodeToString(sum[:16])
}

// cacheGet reads a cached vector. Any miss/error returns ok=false.
func (c *Client) cacheGet(ctx context.Context, key string) ([]float32, bool) {
	if c.rdb == nil {
		return nil, false
	}
	b, err := c.rdb.Get(ctx, key).Bytes()
	if err != nil || len(b) == 0 {
		return nil, false
	}
	return decodeVec(b)
}

// cacheSet stores a vector best-effort; errors are swallowed.
func (c *Client) cacheSet(ctx context.Context, key string, vec []float32) {
	if c.rdb == nil {
		return
	}
	_ = c.rdb.Set(ctx, key, encodeVec(vec), cacheTTL).Err()
}

// encodeVec packs a float32 slice as little-endian IEEE-754, 4 bytes per dim.
func encodeVec(vec []float32) []byte {
	b := make([]byte, 4*len(vec))
	for i, f := range vec {
		binary.LittleEndian.PutUint32(b[i*4:], math.Float32bits(f))
	}
	return b
}

// decodeVec is the inverse of encodeVec. A byte length not divisible by 4 is
// treated as a corrupt entry (cache miss).
func decodeVec(b []byte) ([]float32, bool) {
	if len(b)%4 != 0 {
		return nil, false
	}
	vec := make([]float32, len(b)/4)
	for i := range vec {
		vec[i] = math.Float32frombits(binary.LittleEndian.Uint32(b[i*4:]))
	}
	return vec, true
}
