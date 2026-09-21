package index_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"testing"
	"time"

	"github.com/jiva-studio/shruti/discovery/internal/application/index"
	"github.com/jiva-studio/shruti/discovery/internal/application/normalize"
	"github.com/jiva-studio/shruti/discovery/internal/infra/fetch"
)

// etagFetcher answers 304 to any conditional request, the way an archive that
// serves ETags does, and records what it was asked.
type etagFetcher struct {
	body      string
	asked     []fetch.Request
	notModify bool
}

func (f *etagFetcher) Get(_ context.Context, url string, req fetch.Request) (*fetch.Response, error) {
	f.asked = append(f.asked, req)
	if req.ETag != "" {
		f.notModify = true
		return &fetch.Response{URL: url, Status: 304, NotModified: true}, nil
	}
	sum := sha256.Sum256([]byte(f.body))
	return &fetch.Response{
		URL: url, Status: 200, ContentType: "text/html", ETag: `"v1"`,
		Body: []byte(f.body), BodySHA256: hex.EncodeToString(sum[:]),
	}, nil
}

func (f *etagFetcher) Allowed(context.Context, string) bool { return true }

// A page last read with a superseded prompt or script must not be asked "has
// this changed?", because an archive that answers 304 answers before there is
// anything to read — the page is recorded as unchanged, its validators are
// never refreshed, and it never catches up. audioveda serves an ETag on 14,534
// of its 14,586 pages, so editing its script had no effect there at all.
func TestASupersededPageIsNotAskedConditionally(t *testing.T) {
	repo := testRepo(t)
	ctx := t.Context()
	now := time.Date(2026, time.August, 7, 12, 0, 0, 0, time.UTC)

	fetcher := &etagFetcher{body: talk}
	svc := &index.Service{
		Fetcher:    fetcher,
		Normalizer: normalize.Stub{},
		Repo:       repo,
		Now:        func() time.Time { return now },
	}
	const url = "https://etag.example/talk"

	if _, err := svc.Item(ctx, url, "", false); err != nil {
		t.Fatal(err)
	}
	// Read once, with a validator stored. A second visit may ask conditionally:
	// nothing about how we read it has moved.
	if _, err := svc.Item(ctx, url, "", false); err != nil {
		t.Fatal(err)
	}
	if len(fetcher.asked) != 2 || fetcher.asked[1].ETag == "" {
		t.Fatalf("the second visit asked %+v; an unchanged page should be asked conditionally", fetcher.asked[1])
	}

	// Now the tooling moves on. Written directly, because a prompt version is
	// what a re-read would change and this test is about the request, not the
	// prompt.
	if _, err := repo.Pool().Exec(ctx,
		`UPDATE discovery.pages SET norm_prompt_version = 'superseded' WHERE url = $1`, url); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Item(ctx, url, "", false); err != nil {
		t.Fatal(err)
	}
	if got := fetcher.asked[2]; got.ETag != "" {
		t.Errorf("asked conditionally with %q: the 304 arrives before the version is compared, "+
			"so this page can never be re-read", got.ETag)
	}

	page, err := repo.PageByURL(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	if page.NormPromptVersion == "superseded" {
		t.Error("the page still claims the superseded prompt; it did not catch up")
	}
}
