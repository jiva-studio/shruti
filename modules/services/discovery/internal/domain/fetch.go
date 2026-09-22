package domain

import (
	"context"
	"errors"
	"strings"
	"time"
)

var (
	// ErrDisallowed means robots.txt forbids this path.
	ErrDisallowed = errors.New("fetch: disallowed by robots.txt")
	// ErrRobotsUnread means the host did not tell us its rules.
	ErrRobotsUnread = errors.New("fetch: robots.txt could not be read")
	// ErrCircuitOpen means this host has failed repeatedly and is cooling down.
	ErrCircuitOpen = errors.New("fetch: circuit breaker open")
	// ErrTooLarge means the response exceeded the body cap.
	ErrTooLarge = errors.New("fetch: response too large")
	// ErrGone means the address no longer holds anything.
	ErrGone = errors.New("fetch: no longer available")
)

// Reader reads an address some other way than an HTTP request.
type Reader interface {
	Name() string
	Read(ctx context.Context, rawURL string, headers map[string]string) (*Reading, error)
}

// Reading is what a reader hands back.
type Reading struct {
	Body        []byte
	ContentType string
}

// FetchRequest is what to ask for: validators and source headers.
type FetchRequest struct {
	ETag         string
	LastModified string
	Headers      map[string]string
	Tool         string
	MinDelay     time.Duration
}

// FetchResponse is one fetched page.
type FetchResponse struct {
	URL          string
	Status       int
	NotModified  bool
	Body         []byte
	BodySHA256   string
	ContentType  string
	ETag         string
	LastModified string
}

// IsHTML reports whether a response carries markup rather than a media file.
func (r *FetchResponse) IsHTML() bool {
	ct := strings.ToLower(r.ContentType)
	return strings.Contains(ct, "html") || strings.Contains(ct, "xml")
}

// FetchErrorKind names why a fetch did not produce a page.
func FetchErrorKind(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, ErrDisallowed):
		return "disallowed"
	case errors.Is(err, ErrRobotsUnread):
		return "robots_unread"
	case errors.Is(err, ErrCircuitOpen):
		return "circuit_open"
	case errors.Is(err, ErrGone):
		return "gone"
	case errors.Is(err, ErrTooLarge):
		return "too_large"
	default:
		return "fetch_failed"
	}
}
