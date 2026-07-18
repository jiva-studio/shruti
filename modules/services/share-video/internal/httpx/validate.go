package httpx

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"

	"github.com/jiva-studio/shruti-share-video/internal/types"
)

const (
	maxBodyBytes   = 32 * 1024
	maxDurationMs  = 120_000
	maxTextChars   = 5_000
	maxTitleChars  = 120
	maxHeaderChars = 200
	maxSubChars    = 120
	maxShlokaChars = 800
)

var (
	sourceKeyRe = regexp.MustCompile(`^public/(tracks|shares)/[^\s]+\.mp3$`)
	videoIDRe   = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	themeRe     = regexp.MustCompile(`^[a-z0-9_-]{1,32}$`)
	langRe      = regexp.MustCompile(`^[a-z]{2}$`)
)

// ValidationError carries a 400-mappable message. Same shape as
// validate.ts ValidationError so error strings match for parity.
type ValidationError struct{ msg string }

func (e *ValidationError) Error() string { return e.msg }

func newVErr(format string, a ...any) *ValidationError {
	return &ValidationError{msg: fmt.Sprintf(format, a...)}
}

// rawBody is the wire shape — snake_case keys (HTTP contract).
type rawBody struct {
	SourceKey *string    `json:"source_key"`
	StartMs   *int64     `json:"start_ms"`
	EndMs     *int64     `json:"end_ms"`
	Text      *string    `json:"text"`
	Lang      *string    `json:"lang"`
	Theme     *string    `json:"theme"`
	VideoID   *string    `json:"video_id"`
	Title     *string    `json:"title"`
	SkipIntro *bool      `json:"skip_intro"`
	SkipLogo  *bool      `json:"skip_logo"`
	Audio     *rawAudio  `json:"audio"`
	Layout    *rawLayout `json:"layout"`
}

// rawAudio / rawLayout mirror the nested request blocks in snake_case.
// DisallowUnknownFields applies to these too, so the shapes must be
// exact.
type rawAudio struct {
	Normalize   *bool `json:"normalize"`
	TrimSilence *bool `json:"trim_silence"`
}

type rawLayout struct {
	Intro    *rawIntro    `json:"intro"`
	Outro    *rawOutro    `json:"outro"`
	Sections *rawSections `json:"sections"`
}

type rawIntro struct {
	Enabled *bool   `json:"enabled"`
	Title   *string `json:"title"`
	Icon    *bool   `json:"icon"`
}

type rawOutro struct {
	Enabled *bool `json:"enabled"`
}

type rawSections struct {
	Header     *rawHeader     `json:"header"`
	Center     *rawCenter     `json:"center"`
	Transcript *rawTranscript `json:"transcript"`
}

type rawHeader struct {
	Enabled *bool   `json:"enabled"`
	Text    *string `json:"text"`
	Sub     *string `json:"sub"`
}

type rawCenter struct {
	Enabled *bool      `json:"enabled"`
	Shloka  *rawShloka `json:"shloka"`
}

type rawShloka struct {
	IAST        *string `json:"iast"`
	Translation *string `json:"translation"`
}

type rawTranscript struct {
	Enabled *bool `json:"enabled"`
}

// parseRenderRequest is the Go port of validate.ts:parseRenderRequest.
// Errors come back as *ValidationError — caller maps to HTTP 400.
func parseRenderRequest(r *http.Request) (types.RenderRequest, error) {
	r.Body = http.MaxBytesReader(nil, r.Body, maxBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()

	var b rawBody
	if err := dec.Decode(&b); err != nil {
		if errors.Is(err, io.EOF) {
			return types.RenderRequest{}, newVErr("body must be a JSON object")
		}
		// MaxBytesReader returns *http.MaxBytesError on overflow.
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return types.RenderRequest{}, newVErr("body too large")
		}
		return types.RenderRequest{}, newVErr("invalid JSON: %s", err)
	}

	// Layout drives whether the transcript section (and therefore text)
	// is required, so parse it up front.
	layout, transcriptEnabled, err := parseLayout(b.Layout)
	if err != nil {
		return types.RenderRequest{}, err
	}
	audio := parseAudio(b.Audio)

	if b.SourceKey == nil || strings.TrimSpace(*b.SourceKey) == "" {
		return types.RenderRequest{}, newVErr("source_key is required and must be a non-empty string")
	}
	if !sourceKeyRe.MatchString(*b.SourceKey) {
		return types.RenderRequest{}, newVErr("source_key must look like public/tracks/<id>/...mp3")
	}
	if b.StartMs == nil {
		return types.RenderRequest{}, newVErr("start_ms must be an integer")
	}
	if b.EndMs == nil {
		return types.RenderRequest{}, newVErr("end_ms must be an integer")
	}
	if *b.StartMs < 0 || *b.EndMs <= *b.StartMs {
		return types.RenderRequest{}, newVErr("end_ms must be greater than start_ms; both must be non-negative")
	}
	if *b.EndMs-*b.StartMs > maxDurationMs {
		return types.RenderRequest{}, newVErr("excerpt longer than %ds is not supported", maxDurationMs/1000)
	}
	text := ""
	if b.Text != nil {
		text = *b.Text
	}
	if transcriptEnabled && strings.TrimSpace(text) == "" {
		return types.RenderRequest{}, newVErr("text is required and must be a non-empty string")
	}
	if len(text) > maxTextChars {
		return types.RenderRequest{}, newVErr("text exceeds %d chars", maxTextChars)
	}
	if b.Lang == nil || strings.TrimSpace(*b.Lang) == "" {
		return types.RenderRequest{}, newVErr("lang is required and must be a non-empty string")
	}
	lang := strings.ToLower(*b.Lang)
	if !langRe.MatchString(lang) {
		return types.RenderRequest{}, newVErr("lang must be ISO-639-1 (two lowercase letters)")
	}
	if b.Theme == nil || strings.TrimSpace(*b.Theme) == "" {
		return types.RenderRequest{}, newVErr("theme is required and must be a non-empty string")
	}
	theme := strings.ToLower(*b.Theme)
	if !themeRe.MatchString(theme) {
		return types.RenderRequest{}, newVErr("theme must match [a-z0-9_-]{1,32}")
	}

	videoID := ""
	if b.VideoID != nil {
		if !videoIDRe.MatchString(*b.VideoID) {
			return types.RenderRequest{}, newVErr("video_id must be alphanumeric / dash / underscore, max 64 chars")
		}
		videoID = *b.VideoID
	}

	title := ""
	if b.Title != nil {
		t := strings.TrimSpace(*b.Title)
		if t != "" {
			if len(t) > maxTitleChars {
				return types.RenderRequest{}, newVErr("title exceeds %d chars", maxTitleChars)
			}
			title = t
		}
	}

	return types.RenderRequest{
		SourceKey: *b.SourceKey,
		StartMs:   *b.StartMs,
		EndMs:     *b.EndMs,
		Text:      text,
		Lang:      lang,
		Theme:     theme,
		VideoID:   videoID,
		Title:     title,
		SkipIntro: b.SkipIntro != nil && *b.SkipIntro,
		SkipLogo:  b.SkipLogo != nil && *b.SkipLogo,
		Audio:     audio,
		Layout:    layout,
	}, nil
}

// parseAudio maps the optional snake_case audio block to the at-rest
// shape. Nil in → nil out (legacy stream-copy).
func parseAudio(a *rawAudio) *types.AudioOptions {
	if a == nil {
		return nil
	}
	out := &types.AudioOptions{}
	if a.Normalize != nil {
		out.Normalize = *a.Normalize
	}
	if a.TrimSilence != nil {
		out.TrimSilence = *a.TrimSilence
	}
	return out
}

// parseLayout validates and maps the optional layout block. It also
// returns whether the transcript section is enabled (default true when
// the layout — or its transcript section — is omitted), which gates the
// text requirement. A layout with no visible content is rejected.
func parseLayout(l *rawLayout) (*types.Layout, bool, error) {
	if l == nil {
		return nil, true, nil // legacy path: single-caption reel
	}
	out := &types.Layout{}

	if l.Intro != nil {
		intro := &types.IntroSpec{}
		if l.Intro.Enabled != nil {
			intro.Enabled = *l.Intro.Enabled
		}
		if l.Intro.Title != nil {
			t := strings.TrimSpace(*l.Intro.Title)
			if len(t) > maxTitleChars {
				return nil, false, newVErr("layout.intro.title exceeds %d chars", maxTitleChars)
			}
			intro.Title = t
		}
		if l.Intro.Icon != nil {
			intro.Icon = *l.Intro.Icon
		}
		out.Intro = intro
	}

	if l.Outro != nil {
		outro := &types.OutroSpec{}
		if l.Outro.Enabled != nil {
			outro.Enabled = *l.Outro.Enabled
		}
		out.Outro = outro
	}

	transcriptEnabled := true
	visible := false // any drawable section present
	if l.Sections != nil {
		s := &types.Sections{}

		if h := l.Sections.Header; h != nil {
			hs := &types.HeaderSection{}
			if h.Enabled != nil {
				hs.Enabled = *h.Enabled
			}
			if h.Text != nil {
				hs.Text = strings.TrimSpace(*h.Text)
			}
			if h.Sub != nil {
				hs.Sub = strings.TrimSpace(*h.Sub)
			}
			if hs.Enabled {
				if hs.Text == "" {
					return nil, false, newVErr("layout.sections.header.text is required when the header is enabled")
				}
				if len(hs.Text) > maxHeaderChars {
					return nil, false, newVErr("layout.sections.header.text exceeds %d chars", maxHeaderChars)
				}
				if len(hs.Sub) > maxSubChars {
					return nil, false, newVErr("layout.sections.header.sub exceeds %d chars", maxSubChars)
				}
				visible = true
			}
			s.Header = hs
		}

		if c := l.Sections.Center; c != nil {
			cs := &types.CenterSection{}
			if c.Enabled != nil {
				cs.Enabled = *c.Enabled
			}
			if c.Shloka != nil {
				sh := &types.Shloka{}
				if c.Shloka.IAST != nil {
					sh.IAST = strings.TrimSpace(*c.Shloka.IAST)
				}
				if c.Shloka.Translation != nil {
					sh.Translation = strings.TrimSpace(*c.Shloka.Translation)
				}
				cs.Shloka = sh
			}
			if cs.Enabled {
				if cs.Shloka == nil || (cs.Shloka.IAST == "" && cs.Shloka.Translation == "") {
					return nil, false, newVErr("layout.sections.center.shloka must have iast or translation when the center is enabled")
				}
				if len(cs.Shloka.IAST) > maxShlokaChars || len(cs.Shloka.Translation) > maxShlokaChars {
					return nil, false, newVErr("layout.sections.center.shloka text exceeds %d chars", maxShlokaChars)
				}
				visible = true
			}
			s.Center = cs
		}

		if t := l.Sections.Transcript; t != nil {
			ts := &types.TranscriptSection{}
			if t.Enabled != nil {
				ts.Enabled = *t.Enabled
			}
			s.Transcript = ts
			transcriptEnabled = ts.Enabled
		}
		out.Sections = s
	}

	if transcriptEnabled {
		visible = true
	}
	if !visible {
		return nil, false, newVErr("layout has no visible content: enable the transcript, header, or center")
	}
	return out, transcriptEnabled, nil
}

// videoIDPathRe accepts both the legacy 36-char UUID-with-dashes form
// and the safe-id form crypto.randomUUID() produces.
var videoIDPathRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$|^[0-9a-f-]{36}$`)
