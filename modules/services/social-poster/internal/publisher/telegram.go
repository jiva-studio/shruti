package publisher

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jiva-studio/lectorium-social-poster/internal/config"
)

// telegramCaptionMax is the Bot API caption limit for media messages.
const telegramCaptionMax = 1024

// Telegram publishes via the Bot API. sendAudio takes the excerpt URL
// directly (Telegram fetches it), so text + audio land in one message.
type Telegram struct {
	name   string
	token  string
	chatID string
	httpc  *http.Client
}

func NewTelegram(name, token, chatID string, httpc *http.Client) *Telegram {
	if httpc == nil {
		httpc = &http.Client{Timeout: 60 * time.Second}
	}
	return &Telegram{name: name, token: token, chatID: chatID, httpc: httpc}
}

func (t *Telegram) Name() string     { return t.name }
func (t *Telegram) Platform() string { return config.PlatformTelegram }

func (t *Telegram) Publish(ctx context.Context, p Post) (Result, error) {
	if p.AudioURL != "" {
		return t.sendAudio(ctx, p)
	}
	return t.sendMessage(ctx, p.Text)
}

func (t *Telegram) sendAudio(ctx context.Context, p Post) (Result, error) {
	form := url.Values{}
	form.Set("chat_id", t.chatID)
	form.Set("audio", p.AudioURL)
	form.Set("caption", truncate(p.Text, telegramCaptionMax))
	if p.Title != "" {
		form.Set("title", p.Title)
	}
	if p.Artist != "" {
		form.Set("performer", p.Artist)
	}
	return t.call(ctx, "sendAudio", form)
}

func (t *Telegram) sendMessage(ctx context.Context, text string) (Result, error) {
	form := url.Values{}
	form.Set("chat_id", t.chatID)
	form.Set("text", text)
	return t.call(ctx, "sendMessage", form)
}

type tgResp struct {
	OK          bool   `json:"ok"`
	Description string `json:"description"`
	Result      struct {
		MessageID int64 `json:"message_id"`
	} `json:"result"`
}

func (t *Telegram) call(ctx context.Context, method string, form url.Values) (Result, error) {
	endpoint := fmt.Sprintf("https://api.telegram.org/bot%s/%s", t.token, method)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := t.httpc.Do(req)
	if err != nil {
		// *url.Error prints the URL, and the URL carries the bot token.
		return Result{}, fmt.Errorf("telegram %s: request failed", method)
	}
	defer resp.Body.Close()

	var out tgResp
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return Result{}, fmt.Errorf("telegram %s: decode: %w", method, err)
	}
	if !out.OK {
		return Result{}, fmt.Errorf("telegram %s failed: %s", method, out.Description)
	}
	return Result{Ref: fmt.Sprintf("%d", out.Result.MessageID)}, nil
}

func truncate(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max-1]) + "…"
}
