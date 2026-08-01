package crawl

import (
	"testing"

	"github.com/jiva-studio/lectorium/discovery/internal/store"
)

// A shape that has produced recordings is visited before one that never has,
// whatever order the links appeared in.
func TestFrontierPrefersProductiveShapes(t *testing.T) {
	f := newFrontier([]string{"https://a.example/"}, 4, map[string]store.ShapeYield{
		"/authors/#": {Pages: 20, Media: 0},
		"/audios/#":  {Pages: 10, Media: 10},
	})
	f.addAll([]string{
		"https://a.example/authors/1",
		"https://a.example/audios/500",
		"https://a.example/authors/2",
	}, 1)

	got, _, ok := f.next()
	if !ok || got != "https://a.example/audios/500" {
		t.Fatalf("first = %q, want the productive shape", got)
	}
}

// A shape nobody has tried yet outranks one that has proved barren, or a crawl
// would only ever revisit what it already knows.
func TestFrontierStillExploresNewShapes(t *testing.T) {
	f := newFrontier([]string{"https://a.example/"}, 4, map[string]store.ShapeYield{
		"/authors/#": {Pages: 40, Media: 0},
	})
	f.addAll([]string{"https://a.example/authors/1", "https://a.example/lectures/7"}, 1)

	got, _, _ := f.next()
	if got != "https://a.example/lectures/7" {
		t.Errorf("first = %q, want the unseen shape", got)
	}
}

// What a run finds changes the order within that same run.
func TestFrontierLearnsDuringTheRun(t *testing.T) {
	f := newFrontier([]string{"https://a.example/"}, 4, nil)
	f.addAll([]string{"https://a.example/x/1", "https://a.example/y/1"}, 1)

	// Both shapes are unseen, so the queue order decides — until one of them
	// turns out to be barren.
	f.record("https://a.example/x/9", 0)
	got, _, _ := f.next()
	if got != "https://a.example/y/1" {
		t.Errorf("first = %q, want the shape not yet known to be empty", got)
	}
}

// Depth breaks ties so one productive shape is not chased downwards forever
// before anything else is looked at.
func TestFrontierPrefersShallowOnATie(t *testing.T) {
	f := newFrontier([]string{"https://a.example/"}, 6, nil)
	f.add("https://a.example/a/1", 4)
	f.add("https://a.example/b/1", 1)

	got, _, _ := f.next()
	if got != "https://a.example/b/1" {
		t.Errorf("first = %q, want the shallower one", got)
	}
}

func TestURLShapeBlanksNumbers(t *testing.T) {
	cases := map[string]string{
		"https://a.example/audios/7378":                  "/audios/#",
		"https://a.example/audios/4145":                  "/audios/#",
		"https://a.example/canto-01-chapter-02-text-13/": "/canto-#-chapter-#-text-#/",
		// Percent escapes are decoded before the numbers are blanked, so the
		// key describes the path and not the encoding.
		"https://a.example/index.php?q=f&f=%2F05_-_X": "/index.php?q=f&f=/#_-_X",
	}
	for in, want := range cases {
		if got := urlShape(in); got != want {
			t.Errorf("%s -> %q, want %q", in, got, want)
		}
	}
}
