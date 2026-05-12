package config

// redacted is the placeholder used for any field that holds a secret.
const redacted = "***REDACTED***"

// Sanitize converts a Config into a JSON-friendly map with secrets
// replaced by `***REDACTED***`. The shape mirrors the yaml so an agent
// can use the keys it sees from `admin_config get` directly when
// composing a `set` command.
//
// Runtime-mutable fields (e.g. provider endpoints that may have been
// changed via `admin_config set ...endpoint`) live on the live
// adapters, not in the Config struct. The MCP tool layer overlays
// those values on top of the map this returns.
func Sanitize(c *Config) map[string]any {
	if c == nil {
		return map[string]any{}
	}
	out := map[string]any{
		"in":               c.In,
		"out":              c.Out,
		"db":               c.DB,
		"default_language": c.DefaultLanguage,
		"cdn": map[string]any{
			"read_base_url": c.CDN.ReadBaseURL,
		},
		"s3": map[string]any{
			"aws":    sanitizeS3(c.S3.AWS),
			"yandex": sanitizeS3(c.S3.Yandex),
		},
		"ffmpeg": map[string]any{
			"bin": c.FFmpeg.Bin,
		},
		"transcribe": sanitizeTranscribe(c.Transcribe),
		"review":     sanitizeReview(c.Review),
		"resolver":   sanitizeResolver(c.Resolver),
		"metadata": map[string]any{
			"endpoint":    c.Metadata.Endpoint,
			"api_key":     redactIfSet(c.Metadata.APIKey),
			"model":       c.Metadata.Model,
			"max_tokens":  c.Metadata.MaxTokens,
			"prompt_path": c.Metadata.PromptPath,
		},
	}
	return out
}

func sanitizeS3(t S3Target) map[string]any {
	return map[string]any{
		"bucket":            t.Bucket,
		"region":            t.Region,
		"endpoint":          t.Endpoint,
		"access_key_id":     redactIfSet(t.AccessKeyID),
		"secret_access_key": redactIfSet(t.SecretAccessKey),
		"force_path_style":  t.ForcePathStyle,
	}
}

func sanitizeTranscribe(t Transcribe) map[string]any {
	providers := map[string]any{}
	for name, p := range t.Providers {
		providers[name] = map[string]any{
			"kind":     p.Kind,
			"model":    p.Model,
			"endpoint": p.Endpoint,
			"api_key":  redactIfSet(p.APIKey),
		}
	}
	return map[string]any{
		"default":   t.Default,
		"providers": providers,
	}
}

func sanitizeReview(r Review) map[string]any {
	providers := map[string]any{}
	for name, p := range r.Providers {
		providers[name] = sanitizeProvider(p)
	}
	return map[string]any{
		"default":     r.Default,
		"chunk_size":  r.ChunkSize,
		"overlap":     r.Overlap,
		"retries":     r.Retries,
		"concurrency": r.Concurrency,
		"hybrid": map[string]any{
			"threshold": r.Hybrid.Threshold,
			"expand":    r.Hybrid.Expand,
		},
		"providers": providers,
	}
}

func sanitizeResolver(r Resolver) map[string]any {
	providers := map[string]any{}
	for name, p := range r.Providers {
		providers[name] = sanitizeProvider(p)
	}
	return map[string]any{
		"default":          r.Default,
		"candidates_top_n": r.CandidatesTopN,
		"providers":        providers,
	}
}

func sanitizeProvider(p ProviderOptions) map[string]any {
	return map[string]any{
		"endpoint":    p.Endpoint,
		"api_key":     redactIfSet(p.APIKey),
		"model":       p.Model,
		"max_tokens":  p.MaxTokens,
		"reasoning":   p.Reasoning,
		"prompt_path": p.PromptPath,
	}
}

func redactIfSet(v string) string {
	if v == "" {
		return ""
	}
	return redacted
}
