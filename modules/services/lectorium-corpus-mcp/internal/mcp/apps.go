package mcpsrv

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/lectorium/modules/services/lectorium-corpus-mcp/internal/envelope"
)

var excerptHTTP = &http.Client{Timeout: 8 * time.Second}

// triggerExcerpt POSTs to share-audio to generate a passage clip. ok=false on
// failure; on success returns the clip url and its ready flag.
func triggerExcerpt(ctx context.Context, endpoint, sourceKey string, startMs, endMs int, excerptID string) (url string, ready, ok bool) {
	if endpoint == "" {
		return "", false, false
	}
	body, _ := json.Marshal(map[string]any{
		"source_key": sourceKey,
		"start_ms":   startMs,
		"end_ms":     endMs,
		"excerpt_id": excerptID,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return "", false, false
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := excerptHTTP.Do(req)
	if err != nil {
		return "", false, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusAccepted {
		return "", false, false
	}
	var out struct {
		URL   string `json:"url"`
		Ready bool   `json:"ready"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", false, false
	}
	return out.URL, out.Ready, true
}

// ── MCP Apps (interactive UI players) ────────────────────────────────────────
//
// Two render-tools point at singlefile ext-apps bundles (apps_html.go + ui/).
// Audio is generated lazily: excerpt_render shows a Play button, whose click
// calls excerpt_prepare via callServerTool to cut the clip on demand.

const (
	mediaPlayerURI   = "ui://corpus/media-player.html"
	excerptPlayerURI = "ui://corpus/excerpt-player.html"
)

// registerApps wires the two render-tools, the excerpt-prepare helper tool, and
// the two UI resources.
func registerApps(srv *server.MCPServer, d *Deps) {
	registerVerseRender(srv, d)
	registerVerseCardResource(srv, d)
	registerMediaGet(srv, d)
	registerLectureExcerpt(srv, d)
	registerExcerptPrepare(srv, d)
	registerMediaPlayerResource(srv, d)
	registerExcerptPlayerResource(srv, d)
}

// excerptKeys derives the deterministic share-audio identifiers for a passage.
// The excerpt_id matches the mobile/chat citation scheme so clips are shared.
func (d *Deps) excerptKeys(trackID string, startMs, endMs int) (sourceKey, excerptID, predictedURL, endpoint string) {
	sourceKey = "public/tracks/" + trackID + "/audio/original.mp3"
	excerptID = "chat-cite-" + trackID + "-" + strconv.Itoa(startMs) + "-" + strconv.Itoa(endMs)
	predictedURL = d.Cfg.MediaBase() + "/public/shares/audio/" + excerptID + ".mp3"
	if d.Cfg.ShareAudioBase != "" {
		endpoint = strings.TrimRight(d.Cfg.ShareAudioBase, "/") + "/excerpts"
	}
	return
}

// originOf returns the scheme://host origin of a URL, or "" if unparseable.
func originOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

// uiMeta builds the *mcp.Meta carrying _meta.ui for a render-tool: the render
// trigger (resourceUri) + visibility. Attached to the tool's Meta before AddTool
// so it appears in tools/list.
func uiMeta(resourceURI string) *mcp.Meta {
	return mcp.NewMetaFromMap(map[string]any{
		"ui": map[string]any{
			"resourceUri": resourceURI,
			"visibility":  []string{"model", "app"},
		},
	})
}

// firstLineShort returns a short single-line title derived from body text.
func firstLineShort(text string, maxRunes int) string {
	line := text
	if i := strings.IndexByte(line, '\n'); i >= 0 {
		line = line[:i]
	}
	return preview(strings.TrimSpace(line), maxRunes)
}

// ── media_render: play an existing video clip ───────────────────────────────────

func registerMediaGet(srv *server.MCPServer, d *Deps) {
	const kind = "media_render"
	t := mcp.NewTool(kind,
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithTitleAnnotation(toolTitles[kind]),
		mcp.WithRawOutputSchema(outputSchemaFor(kind)),
		mcp.WithDescription(
			"Show/play an existing corpus VIDEO clip inline. Call this when the user wants to "+
				"WATCH a clip found via search(types:[\"media\"]) — pass the hit's media_id. "+
				"Renders an inline video player."),
		mcp.WithString("id", mcp.Required(), mcp.Description("Media clip item_id (from a search media hit's media_id).")),
		mcp.WithString("lang", mcp.Description("Transcript language (ISO-639-1).")),
	)
	t.Meta = uiMeta(mediaPlayerURI)
	srv.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		start := time.Now()
		id, err := req.RequireString("id")
		if err != nil || strings.TrimSpace(id) == "" {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "id is required", nil), nil
		}
		id = strings.TrimSpace(id)
		lang := req.GetString("lang", "")
		mediaURL := d.Cfg.MediaBase() + "/public/media/" + id + ".mp4"

		// Optionally enrich with the clip's transcript/title from Postgres.
		var title, text, effLang string
		effLang = lang
		if d.Search != nil {
			hits, herr := d.Search.Media(ctx, id, lang, 50)
			if herr != nil {
				return envelope.Err(kind, envelope.CodeDependencyFailed, herr.Error(), nil), nil
			}
			parts := make([]string, 0, len(hits))
			for _, h := range hits {
				if s := strings.TrimSpace(h.Text); s != "" {
					parts = append(parts, s)
				}
				if effLang == "" && h.Lang != "" {
					effLang = h.Lang
				}
			}
			text = strings.Join(parts, "\n")
			title = firstLineShort(text, 80)
		}

		// Poster = the clip URL with its extension swapped to .jpg (same rule as
		// the app's MediaCard). The transcript goes to the LLM (content), not the
		// widget — the player renders only the video.
		poster := strings.TrimSuffix(mediaURL, ".mp4") + ".jpg"
		data := map[string]any{
			"id":     id,
			"type":   "video",
			"url":    mediaURL,
			"poster": poster,
			"title":  title,
		}
		human := "Video clip " + id
		if title != "" {
			human += " — " + title
		}
		if text != "" {
			human += ".\nTranscript: " + text
		}
		human += "\n" + mediaURL

		logQuery(ctx, kind, id, nil, nil, 1, effLang, start)
		res := mcp.NewToolResultText(human)
		res.StructuredContent = data
		return res, nil
	})
}

// ── excerpt_render: generate + play an audio passage ────────────────────────

const excerptMaxMs = 600000 // share-audio 10-minute cap

func registerLectureExcerpt(srv *server.MCPServer, d *Deps) {
	const kind = "excerpt_render"
	t := mcp.NewTool(kind,
		// Not marked read-only: the rendered player lets the user TRIGGER
		// generation of the clip (a side effect) via the public share-audio
		// service. Idempotent: the excerpt_id is deterministic (same
		// track+window → same cached clip). Open-world: reaches an external host.
		mcp.WithReadOnlyHintAnnotation(false),
		mcp.WithIdempotentHintAnnotation(true),
		mcp.WithOpenWorldHintAnnotation(true),
		mcp.WithTitleAnnotation(toolTitles[kind]),
		mcp.WithRawOutputSchema(outputSchemaFor(kind)),
		mcp.WithDescription(
			"Let the user HEAR a lecture passage inline. Call this when the user wants to LISTEN "+
				"to a specific moment in a track — e.g. from a search(types:[\"track\"]) hit, pass its "+
				"track_id plus start_ms/end_ms. Renders an inline audio player that generates the clip "+
				"on demand (public share-audio, max 10 minutes)."),
		mcp.WithString("track_id", mcp.Required(), mcp.Description("track_id (from a search track hit or track_list).")),
		mcp.WithNumber("start_ms", mcp.Required(), mcp.Description("Passage start (ms).")),
		mcp.WithNumber("end_ms", mcp.Required(), mcp.Description("Passage end (ms), > start_ms; span <= 600000 (10 min).")),
		mcp.WithString("lang", mcp.Description("Transcript language (ISO-639-1).")),
	)
	t.Meta = uiMeta(excerptPlayerURI)
	srv.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		start := time.Now()
		trackID, err := req.RequireString("track_id")
		if err != nil || strings.TrimSpace(trackID) == "" {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "track_id is required", nil), nil
		}
		trackID = strings.TrimSpace(trackID)
		startMs := req.GetInt("start_ms", -1)
		endMs := req.GetInt("end_ms", -1)
		if startMs < 0 || endMs <= startMs {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "end_ms > start_ms >= 0 required", nil), nil
		}
		if endMs-startMs > excerptMaxMs {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "excerpt span exceeds 10 minutes (600000 ms)", nil), nil
		}
		lang := req.GetString("lang", "")

		sd, ad, ld, err := d.loadDicts(ctx)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		tr, err := d.Catalog.GetTrack(ctx, trackID)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		if tr == nil {
			return envelope.Err(kind, envelope.CodeNotFound, "no such track", map[string]any{"track_id": trackID}), nil
		}
		_ = ld // location not needed here; loaded for the shared dict helper
		_ = sd

		// Spoken sentences of [start,end], sliced out of the published transcript.
		segments, text, transcriptLang := d.excerptTranscript(ctx, tr, lang, startMs, endMs)

		// Caller-supplied lang wins; otherwise label the card in the language the
		// passage is actually spoken in, so title and author match the transcript.
		metaLang := lang
		if metaLang == "" {
			metaLang = transcriptLang
		}
		title := tr.Title(metaLang)
		author := ""
		if a, ok := ad.Get(tr.AuthorID); ok {
			author = a.Name(metaLang)
		}

		_, excerptID, _, _ := d.excerptKeys(trackID, startMs, endMs)

		// No generation here — the player calls excerpt_prepare on Play. excerpt_id
		// seeds the waveform. The transcript goes to both the widget (rendered under
		// the player, as in the app's citation card) and the LLM (content).
		data := map[string]any{
			"track_id":   trackID,
			"title":      title,
			"author":     author,
			"date":       tr.Date,
			"start_ms":   startMs,
			"end_ms":     endMs,
			"excerpt_id": excerptID,
			"transcript": segments,
			"lang":       transcriptLang,
		}
		human := "Audio excerpt from " + title
		if author != "" {
			human += " (" + author + ")"
		}
		if text != "" {
			human += ".\nTranscript: " + text
		}

		logQuery(ctx, kind, trackID, map[string]any{"start_ms": startMs, "end_ms": endMs}, nil, 1, lang, start)
		res := mcp.NewToolResultText(human)
		res.StructuredContent = data
		return res, nil
	})
}

// ── excerpt_prepare: lazily generate the clip on Play ────────────────────────

func registerExcerptPrepare(srv *server.MCPServer, d *Deps) {
	const kind = "excerpt_prepare"
	t := mcp.NewTool(kind,
		mcp.WithReadOnlyHintAnnotation(false),
		mcp.WithIdempotentHintAnnotation(true),
		mcp.WithOpenWorldHintAnnotation(true),
		mcp.WithTitleAnnotation(toolTitles[kind]),
		mcp.WithRawOutputSchema(outputSchemaFor(kind)),
		mcp.WithDescription(
			"Generate (or fetch, if cached) the audio clip for a lecture passage and return its "+
				"playable URL. This is the excerpt player's Play action — it is called for you by the "+
				"player UI on demand. Agents should use excerpt_render to show the player, not call this "+
				"directly. Idempotent: same track+window returns the same cached clip."),
		mcp.WithString("track_id", mcp.Required(), mcp.Description("track_id.")),
		mcp.WithNumber("start_ms", mcp.Required(), mcp.Description("Passage start (ms).")),
		mcp.WithNumber("end_ms", mcp.Required(), mcp.Description("Passage end (ms), > start_ms; span <= 600000.")),
	)
	srv.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		start := time.Now()
		trackID, err := req.RequireString("track_id")
		if err != nil || strings.TrimSpace(trackID) == "" {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "track_id is required", nil), nil
		}
		trackID = strings.TrimSpace(trackID)
		startMs := req.GetInt("start_ms", -1)
		endMs := req.GetInt("end_ms", -1)
		if startMs < 0 || endMs <= startMs {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "end_ms > start_ms >= 0 required", nil), nil
		}
		if endMs-startMs > excerptMaxMs {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "excerpt span exceeds 10 minutes (600000 ms)", nil), nil
		}

		sourceKey, excerptID, predictedURL, endpoint := d.excerptKeys(trackID, startMs, endMs)

		// On failure fall back to the predicted URL; the player retries the GET.
		audioURL, ready := predictedURL, false
		if u, rdy, ok := triggerExcerpt(ctx, endpoint, sourceKey, startMs, endMs, excerptID); ok {
			if u != "" {
				audioURL = u
			}
			ready = rdy
		}

		data := map[string]any{
			"url":        audioURL,
			"ready":      ready,
			"excerpt_id": excerptID,
		}
		logQuery(ctx, kind, trackID, map[string]any{"start_ms": startMs, "end_ms": endMs}, nil, 1, "", start)
		res := mcp.NewToolResultText("Prepared audio excerpt: " + audioURL)
		res.StructuredContent = data
		return res, nil
	})
}

// ── UI resources ─────────────────────────────────────────────────────────────

// resourceUIMeta builds the *mcp.Meta carrying _meta.ui.csp for a UI resource,
// so the host reads the app's Content-Security-Policy from resources/list.
func resourceUIMeta(connectDomains, resourceDomains []string) *mcp.Meta {
	return mcp.NewMetaFromMap(map[string]any{
		"ui": map[string]any{
			"csp": map[string]any{
				"connectDomains":  connectDomains,
				"resourceDomains": resourceDomains,
			},
		},
	})
}

// uiContents builds the read result: the HTML with the mcp-app mimeType, and
// (belt-and-suspenders) the same _meta.ui on the contents so a host that reads
// CSP from the read result rather than resources/list still finds it.
func uiContents(uri, html string, ui map[string]any) []mcp.ResourceContents {
	return []mcp.ResourceContents{
		mcp.TextResourceContents{
			URI:      uri,
			MIMEType: "text/html;profile=mcp-app",
			Text:     html,
			Meta:     map[string]any{"ui": ui},
		},
	}
}

func registerMediaPlayerResource(srv *server.MCPServer, d *Deps) {
	mediaOrigin := originOf(d.Cfg.MediaBase())
	// Only the <video> GETs from the media CDN — sole CSP allowance.
	connectDomains := []string{}
	resourceDomains := []string{mediaOrigin}
	csp := map[string]any{
		"connectDomains":  connectDomains,
		"resourceDomains": resourceDomains,
	}
	res := mcp.NewResource(mediaPlayerURI, "Corpus video player",
		mcp.WithResourceDescription("Inline video player for a corpus media clip."),
		mcp.WithMIMEType("text/html;profile=mcp-app"),
	)
	res.Meta = resourceUIMeta(connectDomains, resourceDomains)
	srv.AddResource(res, func(ctx context.Context, req mcp.ReadResourceRequest) ([]mcp.ResourceContents, error) {
		return uiContents(mediaPlayerURI, mediaPlayerHTML, map[string]any{"csp": csp}), nil
	})
}

func registerExcerptPlayerResource(srv *server.MCPServer, d *Deps) {
	mediaOrigin := originOf(d.Cfg.MediaBase())
	// Only the <audio> GETs the clip from the media CDN — sole CSP allowance.
	connectDomains := []string{}
	resourceDomains := []string{mediaOrigin}
	csp := map[string]any{
		"connectDomains":  connectDomains,
		"resourceDomains": resourceDomains,
	}
	res := mcp.NewResource(excerptPlayerURI, "Corpus excerpt player",
		mcp.WithResourceDescription("Inline audio player that generates a lecture-passage clip on demand."),
		mcp.WithMIMEType("text/html;profile=mcp-app"),
	)
	res.Meta = resourceUIMeta(connectDomains, resourceDomains)
	srv.AddResource(res, func(ctx context.Context, req mcp.ReadResourceRequest) ([]mcp.ResourceContents, error) {
		return uiContents(excerptPlayerURI, excerptPlayerHTML, map[string]any{"csp": csp}), nil
	})
}
