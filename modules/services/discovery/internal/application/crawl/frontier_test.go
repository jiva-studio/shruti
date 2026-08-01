package crawl

import (
	"strings"
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

// A crawl pointed at one speaker's Bhagavad-gita goes into it, not out of it.
// The real page puts its breadcrumb — the parent and the site root — above the
// chapter directories, so document order sends the crawl straight out.
func TestFrontierGoesInwardBeforeOutward(t *testing.T) {
	seed := "https://a.example/index.php?q=f&f=%2F02_-_Swamis%2FBhakti_Caitanya_Swami%2FBhagavad_Gita"
	f := newFrontier([]string{seed}, 4, nil)
	f.addAll([]string{
		"https://a.example/", // breadcrumb: site root
		"https://a.example/index.php?q=f&f=%2F02_-_Swamis", // breadcrumb: parent
		"https://a.example/index.php?q=f&f=%2F02_-_Swamis%2FBhakti_Caitanya_Swami%2FBhagavad_Gita%2FChapter-01",
	}, 1)

	got, _, _ := f.next()
	if !strings.Contains(got, "Chapter-01") {
		t.Fatalf("first = %q, want the chapter under the seed", got)
	}
}

// A path seed marks out the directory it sits in.
func TestFrontierScopesAPathSeed(t *testing.T) {
	f := newFrontier([]string{"https://a.example/authors/tushkin/index.html"}, 4, nil)
	f.addAll([]string{
		"https://a.example/about",
		"https://a.example/authors/tushkin/lecture-3",
	}, 1)

	got, _, _ := f.next()
	if got != "https://a.example/authors/tushkin/lecture-3" {
		t.Errorf("first = %q, want the one under the seed", got)
	}
}

// Leaving the seed is discouraged, not forbidden: a shape known to hold
// recordings still gets visited once what is inside has been.
func TestFrontierStillLeavesTheSeedEventually(t *testing.T) {
	f := newFrontier([]string{"https://a.example/inside/"}, 4, map[string]store.ShapeYield{
		"/elsewhere/#": {Pages: 4, Media: 4},
	})
	f.addAll([]string{"https://a.example/elsewhere/1", "https://a.example/inside/a"}, 1)

	first, _, _ := f.next()
	second, _, ok := f.next()
	if !ok || first != "https://a.example/inside/a" {
		t.Fatalf("first = %q, want inside the seed", first)
	}
	if second != "https://a.example/elsewhere/1" {
		t.Errorf("second = %q, want the productive shape outside", second)
	}
}

// One enormous page must not outweigh where the source was pointed.
func TestFrontierCapsTheYield(t *testing.T) {
	f := newFrontier([]string{"https://a.example/inside/"}, 4, map[string]store.ShapeYield{
		"/elsewhere/#": {Pages: 1, Media: 400},
	})
	f.addAll([]string{"https://a.example/elsewhere/1", "https://a.example/inside/a"}, 1)

	got, _, _ := f.next()
	if got != "https://a.example/inside/a" {
		t.Errorf("first = %q; four hundred files on one page outside should not drag the crawl out", got)
	}
}

// A page whose next check has not come around is not followed. Without this
// the backing off from one day to thirty applied only to where a run started,
// and every page reachable by a link was refetched on every tick.
func TestFrontierSkipsPagesNotDueYet(t *testing.T) {
	f := newFrontier([]string{"https://a.example/"}, 4, nil)
	f.setNotDue(map[string]bool{"https://a.example/settled": true})
	f.addAll([]string{"https://a.example/settled", "https://a.example/fresh"}, 1)

	got, _, ok := f.next()
	if !ok || got != "https://a.example/fresh" {
		t.Fatalf("first = %q, want the one that is due", got)
	}
	if _, _, more := f.next(); more {
		t.Error("the settled page should not be queued at all")
	}
}

// A site-wide sitemap must not drag a scoped source across the whole archive.
// One real archive publishes four hundred and thirty-seven addresses; a source
// pointed at one speaker's Bhagavad-gita wants its own dozen.
func TestFrontierScopeFiltersASitemap(t *testing.T) {
	seed := "https://a.example/index.php?q=f&f=%2FSwamis%2FBhakti_Caitanya_Swami%2FBhagavad_Gita"
	f := newFrontier([]string{seed}, 4, nil)

	inside := "https://a.example/index.php?q=f&f=%2FSwamis%2FBhakti_Caitanya_Swami%2FBhagavad_Gita%2FChapter-01"
	outside := "https://a.example/index.php?q=f&f=%2FChowpatty"
	if !f.within(inside) {
		t.Error("a chapter under the seed should count as inside")
	}
	if f.within(outside) {
		t.Error("an unrelated section should not")
	}
}

// A source seeded at the root owns the whole site, so nothing is filtered out.
func TestFrontierRootSeedScopesEverything(t *testing.T) {
	f := newFrontier([]string{"https://a.example/"}, 4, nil)
	for _, u := range []string{"https://a.example/anything", "https://a.example/deep/page"} {
		if !f.within(u) {
			t.Errorf("%s should be inside a root seed", u)
		}
	}
}

// No depth given means no bound. Setting it right would need advance knowledge
// of somebody else's tree, and guessing it wrong silently truncates an archive
// — which it did twice before this was removed.
func TestFrontierHasNoDepthBoundByDefault(t *testing.T) {
	f := newFrontier([]string{"https://a.example/"}, 0, nil)
	f.add("https://a.example/very/deep/one", 40)

	if _, depth, ok := f.next(); !ok || depth != 40 {
		t.Errorf("depth 40 with no bound: ok=%v depth=%d", ok, depth)
	}
}

// An explicit bound is still honoured, for a site that generates endlessly
// long addresses.
func TestFrontierHonoursAnExplicitDepthBound(t *testing.T) {
	f := newFrontier([]string{"https://a.example/"}, 3, nil)
	f.add("https://a.example/ok", 3)
	f.add("https://a.example/too-deep", 4)

	got, _, _ := f.next()
	if got != "https://a.example/ok" {
		t.Fatalf("first = %q", got)
	}
	if _, _, more := f.next(); more {
		t.Error("depth 4 should not be queued when the bound is 3")
	}
}

// A host that redirects http to https serves one page under two names, and its
// own sitemap may list the one it redirects away from — this archive's does.
// Keyed by the full address the schedule never matched, so every sitemap entry
// looked new, was fetched, redirected onto a row we already had, and was
// fetched again ten minutes later: two hundred requests an hour to learn
// nothing.
func TestFrontierSeesThroughTheScheme(t *testing.T) {
	f := newFrontier([]string{"https://a.example/"}, 0, nil)
	f.setNotDue(map[string]bool{"https://a.example/page": true})

	f.add("http://a.example/page", 1)
	if _, _, ok := f.next(); ok {
		t.Error("the http spelling of a settled page should not be queued")
	}
}

// The same page reached by both spellings is one page, not two.
func TestFrontierDoesNotVisitBothSpellings(t *testing.T) {
	f := newFrontier([]string{"https://a.example/"}, 0, nil)
	f.add("https://a.example/x", 1)
	f.add("http://a.example/x", 1)

	if _, _, ok := f.next(); !ok {
		t.Fatal("the first spelling should be queued")
	}
	if _, _, ok := f.next(); ok {
		t.Error("the second spelling is the same page")
	}
}
