package httpx

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"

	"github.com/akdasa-studios/shruti-share-video/internal/types"
)

const (
	maxBodyBytes    = 32 * 1024
	maxDurationMs   = 120_000
	maxTextChars    = 5_000
	maxTitleChars   = 120
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
	SourceKey *string `json:"source_key"`
	StartMs   *int64  `json:"start_ms"`
	EndMs     *int64  `json:"end_ms"`
	Text      *string `json:"text"`
	Lang      *string `json:"lang"`
	Theme     *string `json:"theme"`
	VideoID   *string `json:"video_id"`
	Title     *string `json:"title"`
	SkipIntro *bool   `json:"skip_intro"`
	SkipLogo  *bool   `json:"skip_logo"`
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
	if b.Text == nil || strings.TrimSpace(*b.Text) == "" {
		return types.RenderRequest{}, newVErr("text is required and must be a non-empty string")
	}
	if len(*b.Text) > maxTextChars {
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
		Text:      *b.Text,
		Lang:      lang,
		Theme:     theme,
		VideoID:   videoID,
		Title:     title,
		SkipIntro: b.SkipIntro != nil && *b.SkipIntro,
		SkipLogo:  b.SkipLogo != nil && *b.SkipLogo,
	}, nil
}

// videoIDPathRe accepts both the legacy 36-char UUID-with-dashes form
// and the safe-id form crypto.randomUUID() produces.
var videoIDPathRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$|^[0-9a-f-]{36}$`)
