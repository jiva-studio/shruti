package transcript

import "sort"

const (
	// LangSplitThreshold and LangSplitMinSentences both have to be cleared
	// before a language becomes its own transcript.
	LangSplitThreshold    = 0.10
	LangSplitMinSentences = 3
)

// SplitByLanguage buckets segments into per-language groups. A language clears
// the split only with ≥ LangSplitThreshold of the sentences AND ≥
// LangSplitMinSentences; every other segment (below-threshold or untagged)
// folds into the primary group, so nothing is dropped. The primary is always
// its own group.
func SplitByLanguage(segs []RawSegment, primary string) map[string][]RawSegment {
	counts := map[string]int{}
	for _, sg := range segs {
		counts[sg.Language]++
	}
	minCount := LangSplitMinSentences
	if t := int(float64(len(segs))*LangSplitThreshold + 0.999); t > minCount {
		minCount = t
	}
	kept := map[string]bool{primary: true}
	for lang, n := range counts {
		if lang != "" && n >= minCount {
			kept[lang] = true
		}
	}
	groups := map[string][]RawSegment{}
	for _, sg := range segs {
		lang := sg.Language
		if lang == "" || !kept[lang] {
			lang = primary
		}
		groups[lang] = append(groups[lang], sg)
	}
	return groups
}

// OrderedLanguages returns the group languages with the primary first, then the
// rest alphabetically — a stable, deterministic review/store order.
func OrderedLanguages(groups map[string][]RawSegment, primary string) []string {
	rest := make([]string, 0, len(groups))
	for lang := range groups {
		if lang != primary {
			rest = append(rest, lang)
		}
	}
	sort.Strings(rest)
	out := make([]string, 0, len(groups))
	if _, ok := groups[primary]; ok {
		out = append(out, primary)
	}
	return append(out, rest...)
}

// Reindex renumbers a group's segments from zero so each stored transcript
// carries a contiguous index space.
func Reindex(segs []RawSegment) []RawSegment {
	out := make([]RawSegment, len(segs))
	for i, sg := range segs {
		sg.Idx = i
		out[i] = sg
	}
	return out
}
