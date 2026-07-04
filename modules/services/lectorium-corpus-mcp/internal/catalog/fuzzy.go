package catalog

import (
	"strings"
)

// Match is one fuzzy dict hit. Code is set only for source matches.
type Match struct {
	ID    string
	Code  string
	Name  string
	Score float64
}

// score rates how well query matches a target string in [0,1]. Deterministic
// (no LLM): exact > prefix > substring > token-overlap > edit-distance ratio.
func score(query, target string) float64 {
	q := strings.ToLower(strings.TrimSpace(query))
	t := strings.ToLower(strings.TrimSpace(target))
	if q == "" || t == "" {
		return 0
	}
	if q == t {
		return 1
	}
	if strings.HasPrefix(t, q) {
		return 0.9 + 0.09*ratioLen(q, t)
	}
	if strings.Contains(t, q) {
		return 0.75 + 0.1*ratioLen(q, t)
	}
	if strings.Contains(q, t) {
		return 0.7 + 0.1*ratioLen(t, q)
	}
	// Token overlap (Jaccard) for multi-word queries like "CC Madhya".
	if j := jaccard(q, t); j > 0 {
		return 0.4 + 0.3*j
	}
	// Fall back to a normalized edit-distance ratio.
	return 0.6 * editRatio(q, t)
}

func ratioLen(short, long string) float64 {
	if len(long) == 0 {
		return 0
	}
	return float64(len(short)) / float64(len(long))
}

func jaccard(a, b string) float64 {
	as := strings.Fields(a)
	bs := strings.Fields(b)
	if len(as) == 0 || len(bs) == 0 {
		return 0
	}
	set := map[string]bool{}
	for _, w := range as {
		set[w] = true
	}
	inter := 0
	bset := map[string]bool{}
	for _, w := range bs {
		bset[w] = true
	}
	for w := range set {
		if bset[w] {
			inter++
		}
	}
	union := len(set) + len(bset) - inter
	if union == 0 {
		return 0
	}
	return float64(inter) / float64(union)
}

// editRatio is 1 - normalized Levenshtein distance.
func editRatio(a, b string) float64 {
	d := levenshtein([]rune(a), []rune(b))
	m := len(a)
	if len(b) > m {
		m = len(b)
	}
	if m == 0 {
		return 0
	}
	r := 1 - float64(d)/float64(m)
	if r < 0 {
		return 0
	}
	return r
}

func levenshtein(a, b []rune) int {
	la, lb := len(a), len(b)
	if la == 0 {
		return lb
	}
	if lb == 0 {
		return la
	}
	prev := make([]int, lb+1)
	cur := make([]int, lb+1)
	for j := 0; j <= lb; j++ {
		prev[j] = j
	}
	for i := 1; i <= la; i++ {
		cur[0] = i
		for j := 1; j <= lb; j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			cur[j] = min3(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
		}
		prev, cur = cur, prev
	}
	return prev[lb]
}

func min3(a, b, c int) int {
	m := a
	if b < m {
		m = b
	}
	if c < m {
		m = c
	}
	return m
}

// ResolveSources returns the best source matches for a free-text query.
func (r *Repo) ResolveSources(d *SourceDict, query string, lang string, limit int) []Match {
	var out []Match
	for _, id := range d.order {
		s := d.byID[id]
		best := 0.0
		for _, v := range s.Codes {
			if sc := score(query, v); sc > best {
				best = sc
			}
		}
		for _, v := range s.Names {
			if sc := score(query, v); sc > best {
				best = sc
			}
		}
		if best <= 0 {
			continue
		}
		out = append(out, Match{ID: id, Code: s.Code(lang), Name: s.Name(lang), Score: round2(best)})
	}
	return topN(out, limit)
}

// ResolveEntities returns the best author/location matches for a query.
func (r *Repo) ResolveEntities(d *EntityDict, query string, lang string, limit int) []Match {
	var out []Match
	for _, id := range d.order {
		e := d.byID[id]
		best := 0.0
		for _, v := range e.Names {
			if sc := score(query, v); sc > best {
				best = sc
			}
		}
		if best <= 0 {
			continue
		}
		out = append(out, Match{ID: id, Name: e.Name(lang), Score: round2(best)})
	}
	return topN(out, limit)
}

func round2(f float64) float64 {
	return float64(int(f*100+0.5)) / 100
}

// topN sorts matches by score desc (id asc tiebreak) and truncates to n.
func topN(m []Match, n int) []Match {
	for i := 1; i < len(m); i++ {
		for j := i; j > 0 && (m[j].Score > m[j-1].Score ||
			(m[j].Score == m[j-1].Score && m[j].ID < m[j-1].ID)); j-- {
			m[j], m[j-1] = m[j-1], m[j]
		}
	}
	if n > 0 && len(m) > n {
		m = m[:n]
	}
	return m
}
