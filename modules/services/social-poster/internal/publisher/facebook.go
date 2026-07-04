package publisher

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jiva-studio/shruti-social-poster/internal/config"
)

const fbGraphVersion = "v21.0"

// Facebook publishes to a Page feed via the Graph API. With a poster it
// posts a photo (image by URL + caption); without one, a plain feed post.
// No native audio — audio is Telegram-only.
type Facebook struct {
	name   string
	pageID string
	token  string
	httpc  *http.Client
}

func NewFacebook(name, pageID, token string, httpc *http.Client) *Facebook {
	if httpc == nil {
		httpc = &http.Client{Timeout: 60 * time.Second}
	}
	return &Facebook{name: name, pageID: pageID, token: token, httpc: httpc}
}

func (f *Facebook) Name() string     { return f.name }
func (f *Facebook) Platform() string { return config.PlatformFacebook }

func (f *Facebook) Publish(ctx context.Context, p Post) (Result, error) {
	form := url.Values{}
	form.Set("access_token", f.token)

	var node string
	if p.ImageURL != "" {
		node = "photos"
		form.Set("url", p.ImageURL)
		form.Set("caption", p.Text)
	} else {
		node = "feed"
		form.Set("message", p.Text)
	}

	endpoint := fmt.Sprintf("https://graph.facebook.com/%s/%s/%s", fbGraphVersion, f.pageID, node)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := f.httpc.Do(req)
	if err != nil {
		return Result{}, fmt.Errorf("facebook %s: %w", node, err)
	}
	defer resp.Body.Close()

	var out struct {
		ID     string `json:"id"`
		PostID string `json:"post_id"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return Result{}, fmt.Errorf("facebook %s: decode: %w", node, err)
	}
	if out.Error != nil {
		return Result{}, fmt.Errorf("facebook %s failed: %s", node, out.Error.Message)
	}
	ref := out.PostID
	if ref == "" {
		ref = out.ID
	}
	return Result{Ref: ref}, nil
}
