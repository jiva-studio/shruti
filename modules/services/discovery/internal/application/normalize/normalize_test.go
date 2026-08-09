package normalize_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jiva-studio/shruti/discovery/internal/application/normalize"
	"github.com/jiva-studio/shruti/discovery/internal/domain"
)

// The material is part of the input, not a hint beside it. If it sat outside
// the hash, teaching a script to hand over a video's title would change what
// every future recording is read from and leave the ones already stored read
// from nothing — the change would look applied and reach almost nobody.
func TestChangingTheMaterialChangesTheHash(t *testing.T) {
	batch := normalize.Batch{
		PageURL: "https://example.org/p",
		Items: []normalize.Input{{
			MediaURL: "https://example.org/a.mp3",
			Filename: "a.mp3",
		}},
	}
	bare := normalize.InputHash(batch, 0, "v1", "m")

	batch.Items[0].Material = []domain.Material{{Label: "video title", Text: "ШБ 9.10.12"}}
	withMaterial := normalize.InputHash(batch, 0, "v1", "m")
	if bare == withMaterial {
		t.Fatal("handing the model new material left the hash alone")
	}

	batch.Items[0].Material[0].Text = "ШБ 9.10.13"
	changed := normalize.InputHash(batch, 0, "v1", "m")
	if changed == withMaterial {
		t.Error("different material, same hash")
	}

	// And the label is part of it: the same words under a different label are a
	// different claim about what they are.
	batch.Items[0].Material[0].Label = "listing line"
	relabelled := normalize.InputHash(batch, 0, "v1", "m")
	if relabelled == changed {
		t.Error("relabelling the material left the hash alone")
	}
}

// A reply that did not echo the numbers it was given cannot be matched to the
// files it was asked about, so none of it is kept. Nothing downstream notices
// on its own: every answer is plausible on the wrong file, and the input hash
// is stamped on all of them.
func TestAMisnumberedReplyIsNotAnAnswer(t *testing.T) {
	for name, body := range map[string]string{
		"numbered from one": `{"items":[{"n":1,"title":"A"},{"n":2,"title":"B"}]}`,
		"one file twice":    `{"items":[{"n":0,"title":"A"},{"n":0,"title":"B"}]}`,
		"one file missing":  `{"items":[{"n":0,"title":"A"}]}`,
		"a file too many":   `{"items":[{"n":0,"title":"A"},{"n":1,"title":"B"},{"n":2,"title":"C"}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			got := askTwoFiles(t, &reply{body: body})
			for i, r := range got {
				if !r.Unanswered {
					t.Errorf("file %d kept %q from a reply that lost track of it", i, r.Title)
				}
			}
		})
	}
}

// A reply that echoes them is believed, in the order the files were given.
func TestAWellNumberedReplyIsBelieved(t *testing.T) {
	got := askTwoFiles(t, &reply{body: `{"items":[{"n":1,"title":"B"},{"n":0,"title":"A"}]}`})
	if len(got) != 2 || got[0].Title != "A" || got[1].Title != "B" {
		t.Errorf("= %+v", got)
	}
}

// A reply cut off before it finished is not asked for again whole: the same
// files make the same request. The group is halved until what is asked fits.
func TestACutOffReplyIsAskedForInSmallerPieces(t *testing.T) {
	srv := &reply{
		body:   `{"items":[{"n":0,"title":"A"}]}`,
		cutoff: func(n int) bool { return n > 1 },
	}
	got := askTwoFiles(t, srv)
	if len(got) != 2 || got[0].Title != "A" || got[1].Title != "A" {
		t.Fatalf("= %+v", got)
	}
	// The whole group, then each half: the cut-off call is not repeated at the
	// size that could not fit.
	if srv.calls != 3 {
		t.Errorf("%d calls, want the group and then its two halves", srv.calls)
	}
}

// reply is a provider that answers with whatever it was told to, and reports a
// reply cut short for groups above a given size.
type reply struct {
	body   string
	cutoff func(files int) bool
	calls  int
	sizes  []int
}

func (r *reply) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	var in struct {
		Messages []struct{ Content string } `json:"messages"`
	}
	_ = json.NewDecoder(req.Body).Decode(&in)
	files := strings.Count(in.Messages[len(in.Messages)-1].Content, `"n":`)
	r.calls++
	r.sizes = append(r.sizes, files)

	finish, body := "stop", r.body
	if r.cutoff != nil && r.cutoff(files) {
		// What a provider actually sends: as much JSON as fitted, and the reason.
		finish, body = "length", `{"items":[{"n":0,"tit`
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"choices": []any{map[string]any{
			"message":       map[string]string{"content": body},
			"finish_reason": finish,
		}},
		"usage": map[string]any{"prompt_tokens": 10, "completion_tokens": 5},
	})
}

// askTwoFiles reads two files through a live normalizer pointed at the fake.
func askTwoFiles(t *testing.T, srv *reply) []normalize.Result {
	t.Helper()
	ts := httptest.NewServer(srv)
	t.Cleanup(ts.Close)

	llm, err := normalize.NewLLM(normalize.LLMOptions{
		Endpoint: ts.URL, APIKey: "test", Model: "test/model",
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := llm.Normalize(context.Background(), normalize.Batch{
		PageURL: "https://example.org/p",
		Items: []normalize.Input{
			{MediaURL: "https://example.org/a.mp3", Filename: "a.mp3"},
			{MediaURL: "https://example.org/b.mp3", Filename: "b.mp3"},
		},
	})
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("%d results for 2 files", len(got))
	}
	return got
}
