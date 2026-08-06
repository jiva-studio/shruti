// Package ytdlp reads an address that an HTTP client cannot read on its own.
//
// YouTube signs its caption addresses and hides the signature behind a
// JavaScript challenge, so a plain GET returns a page with nothing in it.
// yt-dlp answers the challenge; a modern JS runtime is what lets it, and the
// image carries node for exactly this.
//
// It is one implementation of fetch.Reader and knows nothing about the crawl.
// The gap between requests, the per-host limiter and the breaker stay where
// they were: a reader that spawns a process is no less polite than one that
// opens a socket.
package ytdlp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os/exec"
	"sort"
	"strings"
	"time"

	"github.com/hashicorp/go-retryablehttp"

	"github.com/jiva-studio/shruti/discovery/internal/infra/fetch"
)

// Name is what a source names to select this reader.
const Name = "ytdlp"

// defaultTimeout bounds one invocation. A channel listing of several hundred
// videos is one call and takes a while; a stuck one must not hold a worker for
// ever.
const defaultTimeout = 4 * time.Minute

// Options is what the reader needs to run.
type Options struct {
	// UserAgent identifies us when the reader goes and fetches a caption track.
	UserAgent string
	// Proxy is passed to yt-dlp. A datacenter address reading YouTube is met
	// with a bot check, so the one host that needs this reader also needs
	// somewhere else to be read from.
	Proxy string
	// MaxBody caps what will be read, both the dump and the captions.
	MaxBody int64
	// Timeout bounds one invocation.
	Timeout time.Duration
}

type Client struct {
	opts Options
	http *retryablehttp.Client
}

func New(opts Options) *Client {
	if opts.MaxBody <= 0 {
		opts.MaxBody = 8 << 20
	}
	if opts.Timeout <= 0 {
		opts.Timeout = defaultTimeout
	}
	rc := retryablehttp.NewClient()
	rc.Logger = nil
	return &Client{opts: opts, http: rc}
}

func (c *Client) Name() string { return Name }

// Read runs yt-dlp over one address and hands back what it said.
func (c *Client) Read(ctx context.Context, rawURL string, _ map[string]string) (*fetch.Reading, error) {
	ctx, cancel := context.WithTimeout(ctx, c.opts.Timeout)
	defer cancel()

	args := []string{
		"--dump-single-json",
		"--no-warnings",
		// Without a runtime yt-dlp falls back to a client that answers
		// LOGIN_REQUIRED, and every call reads as a bot check.
		"--js-runtimes", "node",
		// A listing must not fetch each video: the entries carry id, title and
		// duration already.
		"--flat-playlist",
		// We index recordings, we do not download them. Without this a video
		// whose streams are DRM-protected or otherwise unavailable is reported
		// as "not available" and lost — though its title, date, duration and
		// captions are all right there. On one channel that was four talks in
		// five.
		"--ignore-no-formats-error",
	}
	if c.opts.Proxy != "" {
		args = append(args, "--proxy", c.opts.Proxy)
	}
	args = append(args, rawURL)

	// Capped rather than collected: a channel dump is arbitrarily large and
	// this used to read all of it into memory before the size check further up
	// the stack rejected it.
	out := &capped{limit: c.opts.MaxBody}
	var errb bytes.Buffer
	cmd := exec.CommandContext(ctx, "yt-dlp", args...)
	cmd.Stdout = out
	cmd.Stderr = &errb
	// CommandContext kills yt-dlp, not the node it starts for the JS challenge,
	// and that child inherits the output pipe — so without a delay Wait can
	// block past the kill, holding the worker on a page that is already over.
	cmd.WaitDelay = 10 * time.Second

	if err := cmd.Run(); err != nil {
		if gone(errb.String()) {
			return nil, fmt.Errorf("%w: %s: %s", fetch.ErrGone, rawURL, tail(errb.String()))
		}
		return nil, fmt.Errorf("yt-dlp %s: %w: %s", rawURL, err, tail(errb.String()))
	}
	if out.over {
		return nil, fmt.Errorf("yt-dlp %s: %w", rawURL, fetch.ErrTooLarge)
	}
	return &fetch.Reading{
		Body:        c.indexable(ctx, out.buf.Bytes()),
		ContentType: "application/json",
	}, nil
}

// capped collects output up to a limit and then keeps counting without keeping.
// A subprocess whose stdout nobody reads blocks, so the writes have to be
// accepted whether or not they are wanted.
type capped struct {
	buf   bytes.Buffer
	limit int64
	over  bool
}

func (c *capped) Write(p []byte) (int, error) {
	if room := c.limit - int64(c.buf.Len()); room > 0 {
		if int64(len(p)) <= room {
			return c.buf.Write(p)
		}
		_, _ = c.buf.Write(p[:room])
	}
	c.over = true
	return len(p), nil
}

// catalogue is the part of yt-dlp's output that describes what could be
// downloaded rather than what was: a caption track in every one of a hundred
// and fifty languages, every stream format, every thumbnail size.
//
// Dropping it is not tidiness. Those addresses are signed per request, so
// keeping them makes the body different on every reading of a video that has
// not changed by a second — and the body is what the crawl compares to decide
// it can stop early. Without that exit the recheck backoff never starts, and a
// channel that gains a talk a week is read end to end every day for ever.
//
// These are yt-dlp's own field names, not any one site's: the same keys come
// back from every extractor it has.
var catalogue = []string{
	"automatic_captions", "subtitles", "formats", "thumbnails",
	"requested_downloads", "requested_formats", "epoch",
}

// indexable is what the reader hands over: what it read, without the catalogue
// of what it could have read.
//
// The caption text goes in under a name of ours, so a script can tell what the
// site said from what we went and got. A missing or unreadable caption is not a
// failure — the recording is indexed either way, and the text is a search key
// whose absence costs a search, not a record.
func (c *Client) indexable(ctx context.Context, body []byte) []byte {
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(body, &doc); err != nil {
		return body
	}
	if captions := c.captions(ctx, body); len(captions) > 0 {
		if encoded, err := json.Marshal(captions); err == nil {
			doc["_captions"] = encoded
		}
	}
	for _, key := range catalogue {
		delete(doc, key)
	}
	// Go writes map keys in order, so the same reading twice is the same bytes.
	out, err := json.Marshal(doc)
	if err != nil {
		return body
	}
	return out
}

// Caption is one caption track, fetched.
type Caption struct {
	Lang string `json:"lang"`
	// Origin is "published" for what the uploader put there and "auto" for what
	// the machine heard. They are not the same evidence and a reader of the
	// text is entitled to know which it has.
	Origin string `json:"origin"`
	JSON3  string `json:"json3"`
}

// captions fetches every caption track worth keeping. yt-dlp names the
// addresses but does not fetch them, and a source's script cannot: a script is
// given no network on purpose.
//
// What the uploader published is taken in every language they published, because
// each is separate human work. What the machine heard is taken in ONE language
// only — the one the talk was given in.
//
// That second rule is the whole of it. YouTube offers the machine transcript
// auto-translated into a hundred and fifty-odd languages, and they are all the
// same talk run through a translator. Taking them all would be a hundred and
// fifty requests per video and a hundred and fifty copies of one text; taking
// the wrong one is worse, and is what a fixed preference for English does to a
// Russian lecture — it stores the machine's English translation of it and calls
// that the transcript.
func (c *Client) captions(ctx context.Context, body []byte) []Caption {
	var doc struct {
		Language          string             `json:"language"`
		AutomaticCaptions map[string][]track `json:"automatic_captions"`
		Subtitles         map[string][]track `json:"subtitles"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil
	}

	var out []Caption
	for _, lang := range sortedLangs(doc.Subtitles) {
		if url := pick(doc.Subtitles[lang]); url != "" {
			if text := c.fetch(ctx, url); text != "" {
				out = append(out, Caption{Lang: lang, Origin: "published", JSON3: text})
			}
		}
	}
	if len(out) > 0 {
		return out
	}
	lang, url := original(doc.AutomaticCaptions, doc.Language)
	if url == "" {
		return nil
	}
	if text := c.fetch(ctx, url); text != "" {
		out = append(out, Caption{Lang: lang, Origin: "auto", JSON3: text})
	}
	return out
}

// original finds the machine transcript in the language actually spoken.
//
// The "-orig" suffix is how the site marks it: where a talk is in English, "en"
// is one of the translation targets and "en-orig" is what was heard. Where it
// does not say, the info the reader gives about the recording does — "ru-RU"
// means the Russian track is the real one and every other is derived from it.
func original(tracks map[string][]track, language string) (string, string) {
	for _, lang := range sortedLangs(tracks) {
		if strings.HasSuffix(lang, "-orig") {
			if url := pick(tracks[lang]); url != "" {
				return strings.TrimSuffix(lang, "-orig"), url
			}
		}
	}
	if spoken := baseLang(language); spoken != "" {
		if url := pick(tracks[spoken]); url != "" {
			return spoken, url
		}
	}
	// Nothing says which language was spoken, so nothing here can be called the
	// original. A translation stored as the transcript is worse than no
	// transcript: it reads as evidence and is not.
	return "", ""
}

// baseLang turns "en-US" into "en". Caption tracks are keyed by the bare
// subtag; the recording's language is not always written that way.
func baseLang(s string) string {
	if i := strings.IndexAny(s, "-_"); i > 0 {
		return strings.ToLower(s[:i])
	}
	return strings.ToLower(s)
}

func sortedLangs(tracks map[string][]track) []string {
	out := make([]string, 0, len(tracks))
	for lang := range tracks {
		out = append(out, lang)
	}
	sort.Strings(out)
	return out
}

type track struct {
	Ext string `json:"ext"`
	URL string `json:"url"`
}

func pick(tracks []track) string {
	for _, t := range tracks {
		if t.Ext == captionFormat {
			return t.URL
		}
	}
	return ""
}

// captionFormat is the one caption format worth asking for. It is YouTube's,
// which is a wrinkle: yt-dlp reads many sites and they do not all speak it.
// The day a second site needs this reader, the format belongs in the source's
// own script rather than here.
const captionFormat = "json3"

func (c *Client) fetch(ctx context.Context, url string) string {
	req, err := retryablehttp.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return ""
	}
	req.Header.Set("User-Agent", c.opts.UserAgent)
	resp, err := c.http.Do(req)
	if err != nil {
		slog.WarnContext(ctx, "captions_not_fetched", "err", err.Error())
		return ""
	}
	defer resp.Body.Close()
	text, err := io.ReadAll(io.LimitReader(resp.Body, c.opts.MaxBody))
	if err != nil {
		return ""
	}
	return string(text)
}

// goneVideos are yt-dlp's ways of saying this one recording cannot be read:
// deleted, private, restricted to members, gated behind an age check. They are
// the subprocess's 404, and a channel of a thousand talks has dozens of them.
//
// Counting them against the host drops the whole channel after five dead links
// in a row — which is precisely what a listing hands you, because entries go
// dead in the order they were published.
//
// Each phrase names a state of the recording itself. Nothing here is about
// formats or streams: those are the reader's business and we ask it not to care
// about them, so a phrase like "not available" — which a perfectly readable
// talk produces when its streams are protected — is deliberately absent. So is
// "Sign in to confirm you're not a bot": that is the site refusing us, and the
// breaker is what should catch it.
var goneVideos = []string{
	"video unavailable",
	"private video",
	"video is private",
	"removed by the uploader",
	"has been terminated",
	"members-only",
	"available to this channel's members",
	"confirm your age",
}

func gone(stderr string) bool {
	low := strings.ToLower(stderr)
	for _, phrase := range goneVideos {
		if strings.Contains(low, phrase) {
			return true
		}
	}
	return false
}

func tail(s string) string {
	if len(s) > 300 {
		return s[len(s)-300:]
	}
	return s
}
