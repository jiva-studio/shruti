package mcpsrv

import (
	"context"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/envelope"
)

// ── MCP Apps (interactive UI players) ────────────────────────────────────────
//
// Two render-tools declare an inline UI via _meta.ui.resourceUri; each points
// at an HTML resource served with mimeType text/html;profile=mcp-app. The tool
// RESULT ships the flat player data on CallToolResult.StructuredContent (the UI
// channel) plus a short human `content` text. The served HTML loads the
// @modelcontextprotocol/ext-apps App from esm.sh, reads result.structuredContent
// in app.ontoolresult, and renders. The App auto-resizes the host iframe to its
// content (autoResize defaults true → a ResizeObserver drives sendSizeChanged),
// so the players size to their real content, not a fixed square.

const (
	mediaPlayerURI   = "ui://corpus/media-player.html"
	excerptPlayerURI = "ui://corpus/excerpt-player.html"
)

// registerApps wires the two render-tools and their two UI resources.
func registerApps(srv *server.MCPServer, d *Deps) {
	registerMediaGet(srv, d)
	registerLectureExcerpt(srv, d)
	registerMediaPlayerResource(srv, d)
	registerExcerptPlayerResource(srv, d)
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

// ── media_get: play an existing video clip ───────────────────────────────────

func registerMediaGet(srv *server.MCPServer, d *Deps) {
	const kind = "media_get"
	t := mcp.NewTool(kind,
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithTitleAnnotation(toolTitles[kind]),
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

		data := map[string]any{
			"id":    id,
			"type":  "video",
			"url":   mediaURL,
			"title": title,
			"text":  text,
			"lang":  effLang,
		}
		human := "Video clip " + id
		if s := snippet(text); s != "" {
			human += ": " + s
		}
		human += ". " + mediaURL

		logQuery(ctx, kind, id, nil, nil, 1, effLang, start)
		res := mcp.NewToolResultText(human)
		res.StructuredContent = data
		return res, nil
	})
}

// ── lecture_excerpt: generate + play an audio passage ────────────────────────

const excerptMaxMs = 600000 // share-audio 10-minute cap

func registerLectureExcerpt(srv *server.MCPServer, d *Deps) {
	const kind = "lecture_excerpt"
	t := mcp.NewTool(kind,
		// Not marked read-only: the rendered player lets the user TRIGGER
		// generation of the clip (a side effect) via the public share-audio
		// service. Idempotent: the excerpt_id is deterministic (same
		// track+window → same cached clip). Open-world: reaches an external host.
		mcp.WithReadOnlyHintAnnotation(false),
		mcp.WithIdempotentHintAnnotation(true),
		mcp.WithOpenWorldHintAnnotation(true),
		mcp.WithTitleAnnotation(toolTitles[kind]),
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

		title := tr.Title(lang)
		author := ""
		if a := authorRef(ad, tr.AuthorID, lang); a != nil {
			if n, ok := a["name"].(string); ok {
				author = n
			}
		}
		_ = sd

		// Transcript of [start,end] when Postgres is configured (else empty).
		text := ""
		if d.Search != nil {
			hits, werr := d.Search.Window(ctx, trackID, startMs, endMs, lang, 50)
			if werr == nil {
				parts := make([]string, 0, len(hits))
				for _, h := range hits {
					if s := strings.TrimSpace(h.Text); s != "" {
						parts = append(parts, s)
					}
				}
				text = strings.Join(parts, " ")
			}
		}

		startStr := strconv.Itoa(startMs)
		endStr := strconv.Itoa(endMs)
		sourceKey := "public/tracks/" + trackID + "/audio/original.mp3"
		excerptID := "chat-cite-" + trackID + "-" + startStr + "-" + endStr
		predictedURL := d.Cfg.MediaBase() + "/public/shares/audio/" + excerptID + ".mp3"
		endpoint := strings.TrimRight(d.Cfg.ShareAudioBase, "/") + "/excerpts"

		data := map[string]any{
			"track_id":   trackID,
			"title":      title,
			"author":     author,
			"date":       tr.Date,
			"track_url":  trackURL(trackID, lang),
			"start_ms":   startMs,
			"end_ms":     endMs,
			"text":       text,
			"excerpt_id": excerptID,
			"audio": map[string]any{
				"endpoint":      endpoint,
				"source_key":    sourceKey,
				"start_ms":      startMs,
				"end_ms":        endMs,
				"excerpt_id":    excerptID,
				"predicted_url": predictedURL,
			},
		}
		human := "Audio excerpt from " + title
		if author != "" {
			human += " (" + author + ")"
		}
		if text != "" {
			human += ": " + snippet(text)
		}

		logQuery(ctx, kind, trackID, map[string]any{"start_ms": startMs, "end_ms": endMs}, nil, 1, lang, start)
		res := mcp.NewToolResultText(human)
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
	// Vanilla self-contained client: no external script. Only the <video> loads
	// from the media CDN, so that's the sole CSP allowance.
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
	// Derive the share-audio connect host from the configured ShareAudioBase so
	// the CSP stays in sync with the endpoint the player POSTs to.
	shareOrigin := originOf(d.Cfg.ShareAudioBase)
	connectDomains := []string{shareOrigin, mediaOrigin}
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
