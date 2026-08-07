package domain_test

import (
	"bufio"
	"os"
	"sort"
	"strings"
	"testing"

	"github.com/jiva-studio/lectorium/discovery/internal/domain"
)

// A reader is only as good as the corpus it was written for, and this corpus is
// too large to hold as a fixture. Point DISCOVERY_REFS_CORPUS at a dump of it —
// id | source | filename | collection | title | stored refs, one line each —
// and this reports what the reader would do to the whole of it.
//
// It is a measurement rather than an assertion. What it must never do is get
// quietly worse, so the two numbers it prints are the ones to compare against
// the next run.
func TestAgainstTheStoredCorpus(t *testing.T) {
	path := os.Getenv("DISCOVERY_REFS_CORPUS")
	if path == "" {
		t.Skip("set DISCOVERY_REFS_CORPUS to a corpus dump to run this")
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	var (
		items     int
		agreed    int
		lost      int
		gained    int
		differed  int
		found     = map[string]int{}
		disagreed []string
	)
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1<<20), 1<<20)
	for sc.Scan() {
		cols := strings.Split(sc.Text(), "|")
		if len(cols) < 6 {
			continue
		}
		source, filename, collection, title, stored := cols[1], cols[2], cols[3], cols[4], cols[5]
		items++

		// idt reads its references out of the filename; everything else out of
		// the title. Not out of the collection: a collection names the canto
		// and the title names the chapter, so reading the collection alone
		// hangs a whole-canto claim on a recording that is one chapter of it.
		read := domain.Refs(title)
		if source == "idt" {
			read = domain.Refs(filename)
		}
		_ = collection
		if len(read) > 0 {
			found[source]++
		}

		was, now := expand(strings.Split(stored, ",")), expandRefs(read)
		switch {
		case was == "" && now == "":
		case was == now:
			agreed++
		case was == "":
			gained++
		case now == "":
			lost++
			if len(disagreed) < 20 {
				disagreed = append(disagreed, "LOST  "+was+"  <-  "+pick(source, filename, title))
			}
		default:
			differed++
			if len(disagreed) < 20 {
				disagreed = append(disagreed, "DIFF  "+was+" -> "+now+"  <-  "+pick(source, filename, title))
			}
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}

	sources := make([]string, 0, len(found))
	for s := range found {
		sources = append(sources, s)
	}
	sort.Strings(sources)
	t.Logf("items=%d agreed=%d differed=%d lost=%d gained=%d", items, agreed, differed, lost, gained)
	for _, s := range sources {
		t.Logf("  %-16s %d items now carry a reference", s, found[s])
	}
	for _, d := range disagreed {
		t.Logf("  %s", d)
	}
}

func expandRefs(refs []domain.Ref) string {
	var out []string
	for _, r := range refs {
		expanded, _ := domain.ExpandRefs(r.Source, r.Tokens)
		for _, e := range expanded {
			out = append(out, e.Label())
		}
	}
	return join(out)
}

func expand(stored []string) string {
	var out []string
	for _, s := range stored {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return join(out)
}

func join(refs []string) string {
	seen := map[string]bool{}
	uniq := refs[:0]
	for _, r := range refs {
		if !seen[r] {
			seen[r] = true
			uniq = append(uniq, r)
		}
	}
	sort.Strings(uniq)
	return strings.Join(uniq, " ")
}

func pick(source, filename, title string) string {
	if source == "idt" {
		return filename
	}
	return title
}
