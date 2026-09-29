// Package fetch reads a file an operator points at: an http(s) URL or a path
// on this host.
package fetch

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// maxBody bounds a download; the images read this way are avatars.
const maxBody = 25 << 20

// URLOrFile reads an http(s) URL or a local file.
type URLOrFile struct {
	Client *http.Client
}

// New returns a reader with a 30-second download timeout.
func New() URLOrFile { return URLOrFile{Client: &http.Client{Timeout: 30 * time.Second}} }

func (f URLOrFile) Read(ctx context.Context, source string) ([]byte, error) {
	s := strings.TrimSpace(source)
	if s == "" {
		return nil, errors.New("source is required (http(s) URL or local file path)")
	}
	if !strings.HasPrefix(s, "http://") && !strings.HasPrefix(s, "https://") {
		return os.ReadFile(s)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s, nil)
	if err != nil {
		return nil, err
	}
	resp, err := f.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch source: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch source: HTTP %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, maxBody))
}
