package handler_test

import (
	"net/http"
	"sort"
	"strconv"
	"testing"

	"github.com/jiva-studio/shruti/discovery/internal/store"
)

func keysOf(t *testing.T, v any) []string {
	t.Helper()
	m, ok := v.(map[string]any)
	if !ok {
		t.Fatalf("%v is not an object", v)
	}
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func sameKeys(t *testing.T, what string, got []string, want ...string) {
	t.Helper()
	sort.Strings(want)
	if len(got) != len(want) {
		t.Errorf("%s keys = %v, want %v", what, got, want)
		return
	}
	for i := range got {
		if got[i] != want[i] {
			t.Errorf("%s keys = %v, want %v", what, got, want)
			return
		}
	}
}

// A run is shown the same way wherever it appears: on its own, in the list, and
// as a source's last pass. The operator console reads these names.
func TestARunKeepsItsShape(t *testing.T) {
	h, repo := testRouter(t)
	ctx := t.Context()
	if code, _ := do(t, h, http.MethodPost, "/discovery/sources",
		`{"id":"a","seed_urls":["https://a.example/"]}`); code != http.StatusOK {
		t.Fatal("could not create the source")
	}
	run, err := repo.StartRun(ctx, "a", false)
	if err != nil {
		t.Fatal(err)
	}
	run.PagesFetched, run.ItemsNew, run.Failures = 3, 2, 1
	run.Errors["gone"] = 1
	if err := repo.FinishRun(ctx, run); err != nil {
		t.Fatal(err)
	}

	finished := []string{"id", "source_id", "dry_run", "started_at", "finished_at", "pages_fetched",
		"pages_unchanged", "items_found", "items_new", "items_changed", "failures", "errors"}

	code, one := do(t, h, http.MethodGet, "/discovery/runs/"+strconv.FormatInt(run.ID, 10), "")
	if code != http.StatusOK {
		t.Fatalf("run = %d %v", code, one)
	}
	sameKeys(t, "run", keysOf(t, one), finished...)
	if one["source_id"] != "a" || one["pages_fetched"] != float64(3) || one["items_new"] != float64(2) {
		t.Errorf("run = %v", one)
	}
	if errs, _ := one["errors"].(map[string]any); errs["gone"] != float64(1) {
		t.Errorf("errors = %v", one["errors"])
	}

	code, list := do(t, h, http.MethodGet, "/discovery/runs", "")
	if code != http.StatusOK {
		t.Fatalf("runs = %d %v", code, list)
	}
	runs, _ := list["runs"].([]any)
	if len(runs) != 1 {
		t.Fatalf("runs = %v", list["runs"])
	}
	sameKeys(t, "listed run", keysOf(t, runs[0]), finished...)

	code, sources := do(t, h, http.MethodGet, "/discovery/sources", "")
	if code != http.StatusOK {
		t.Fatalf("sources = %d %v", code, sources)
	}
	listed, _ := sources["sources"].([]any)
	if len(listed) != 1 {
		t.Fatalf("sources = %v", sources["sources"])
	}
	src, _ := listed[0].(map[string]any)
	sameKeys(t, "last run", keysOf(t, src["last_run"]), finished...)

	// A run the process never saw finish says so and names no finish time.
	open, err := repo.StartRun(ctx, "a", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.MarkInterruptedRuns(ctx); err != nil {
		t.Fatal(err)
	}
	code, cut := do(t, h, http.MethodGet, "/discovery/runs/"+strconv.FormatInt(open.ID, 10), "")
	if code != http.StatusOK {
		t.Fatalf("run = %d %v", code, cut)
	}
	sameKeys(t, "interrupted run", keysOf(t, cut), "id", "source_id", "dry_run", "started_at",
		"pages_fetched", "pages_unchanged", "items_found", "items_new", "items_changed", "failures",
		"interrupted")
}

// A cycle is listed with its own fields and its parts, flat, under the names
// the console reads.
func TestACollectionKeepsItsShape(t *testing.T) {
	h, repo := testRouter(t)
	ctx := t.Context()
	if code, _ := do(t, h, http.MethodPost, "/discovery/sources",
		`{"id":"a","seed_urls":["https://a.example/"]}`); code != http.StatusOK {
		t.Fatal("could not create the source")
	}
	c := &store.Collection{SourceID: "a", Title: "Course", Author: "Radhanath Swami"}
	if err := repo.SaveCollection(ctx, c); err != nil {
		t.Fatal(err)
	}
	for _, media := range []string{"https://a.example/1.mp3", "https://a.example/2.mp3"} {
		src := "a"
		it := &store.Item{MediaURL: media, Title: media, SourceID: &src}
		if _, err := repo.SaveItem(ctx, it); err != nil {
			t.Fatal(err)
		}
		if err := repo.AddMember(ctx, c.ID, it.ID); err != nil {
			t.Fatal(err)
		}
	}

	code, body := do(t, h, http.MethodGet, "/discovery/collections?source=a", "")
	if code != http.StatusOK {
		t.Fatalf("collections = %d %v", code, body)
	}
	listed, _ := body["collections"].([]any)
	if len(listed) != 1 {
		t.Fatalf("collections = %v", body["collections"])
	}
	sameKeys(t, "collection", keysOf(t, listed[0]),
		"id", "source", "title", "author", "member_count", "members")
	got, _ := listed[0].(map[string]any)
	if got["title"] != "Course" || got["source"] != "a" || got["member_count"] != float64(2) {
		t.Errorf("collection = %v", got)
	}
	members, _ := got["members"].([]any)
	if len(members) != 2 {
		t.Fatalf("members = %v", got["members"])
	}
	sameKeys(t, "member", keysOf(t, members[0]), "ordinal", "item_id", "title", "media_url")
}
