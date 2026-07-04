// Package refs holds the pure (dict-independent) half of reference handling:
// splitting a "BG 2.13" string into book+tokens, normalizing tokens to the
// canonical stored form, numeric token ordering, and merged-range display.
//
// Book-code -> source_id resolution lives in the catalog package (it needs the
// source dict); everything here is string math.
package refs

import (
	"regexp"
	"strconv"
	"strings"
)

// tokenRe matches a trailing reference token: a run of digits, dots and
// dashes starting with a digit (e.g. "2.13", "5.5.3", "1.16-18", "1.16–1.18").
var tokenRe = regexp.MustCompile(`^[0-9][0-9.\-\x{2013}\x{2014}]*$`)

// SplitBookTokens separates a human reference into its book part and its
// (possibly empty) token part. Multi-word book codes are preserved:
// "CC Madhya 8.128" -> ("CC Madhya", "8.128"); "BG" -> ("BG", "").
func SplitBookTokens(ref string) (book, tokens string) {
	fields := strings.Fields(strings.TrimSpace(ref))
	if len(fields) == 0 {
		return "", ""
	}
	last := fields[len(fields)-1]
	if len(fields) >= 2 && tokenRe.MatchString(last) {
		return strings.Join(fields[:len(fields)-1], " "), last
	}
	// A lone token with no book (rare) still counts as tokens-only; a lone
	// word is a bare book.
	if len(fields) == 1 && tokenRe.MatchString(last) {
		return "", last
	}
	return strings.Join(fields, " "), ""
}

// NormalizeToken canonicalizes a token to the stored form:
//   - en/em dashes -> ascii hyphen;
//   - a combined range ("1.16-18", "1.16-1.18") collapses to its first member
//     ("1.16") — every member row stores the identical merged block;
//   - leading zeros are stripped per numeric component ("16.07" -> "16.7").
func NormalizeToken(raw string) string {
	t := strings.TrimSpace(raw)
	t = strings.NewReplacer("–", "-", "—", "-").Replace(t)
	if i := strings.IndexByte(t, '-'); i >= 0 {
		t = t[:i]
	}
	parts := strings.Split(t, ".")
	for i, p := range parts {
		if n, err := strconv.Atoi(p); err == nil {
			parts[i] = strconv.Itoa(n)
		}
	}
	return strings.Join(parts, ".")
}

// CompareTokens orders two tokens numerically component-by-component so that
// "1.2" sorts before "1.10" and a prefix ("1") sorts before "1.1".
func CompareTokens(a, b string) int {
	pa := strings.Split(a, ".")
	pb := strings.Split(b, ".")
	for i := 0; i < len(pa) && i < len(pb); i++ {
		na, ea := strconv.Atoi(pa[i])
		nb, eb := strconv.Atoi(pb[i])
		if ea == nil && eb == nil {
			if na != nb {
				if na < nb {
					return -1
				}
				return 1
			}
			continue
		}
		if pa[i] != pb[i] {
			if pa[i] < pb[i] {
				return -1
			}
			return 1
		}
	}
	switch {
	case len(pa) < len(pb):
		return -1
	case len(pa) > len(pb):
		return 1
	default:
		return 0
	}
}

// CompressRange renders a merged span compactly by dropping the shared leading
// components of the end token: ("1.16","1.18") -> "1.16-18"; ("1.16","1.16") ->
// "1.16" (no range).
func CompressRange(start, end string) string {
	if start == end {
		return start
	}
	ps := strings.Split(start, ".")
	pe := strings.Split(end, ".")
	common := 0
	for common < len(ps) && common < len(pe) && ps[common] == pe[common] {
		common++
	}
	if common == len(pe) {
		return start
	}
	return start + "-" + strings.Join(pe[common:], ".")
}

// Scheme names the token scheme for a maximum component depth.
func Scheme(maxDepth int) string {
	switch {
	case maxDepth >= 3:
		return "canto.chapter.verse"
	case maxDepth == 2:
		return "chapter.verse"
	default:
		return "flat"
	}
}

// Depth returns the number of dot-separated components in a token.
func Depth(tok string) int {
	if tok == "" {
		return 0
	}
	return strings.Count(tok, ".") + 1
}

// IsChapterSummary reports whether a token is a ".0" chapter-summary row
// (e.g. "2.0", "5.5.0") — these are summaries, not verses.
func IsChapterSummary(tok string) bool {
	return strings.HasSuffix(tok, ".0")
}
