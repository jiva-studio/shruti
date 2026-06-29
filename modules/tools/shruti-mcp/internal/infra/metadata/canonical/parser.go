// Package canonical parses shruti dedup-canonical filenames into track
// metadata without calling the LLM. Anything that doesn't match the canonical
// shape returns ok=false and the caller should fall back to the LLM extractor.
//
// Canonical layout produced by resources/lake-in/dedup.py:
//
//	outbox/sorted/<lang>/<YYYY-MM-DD>/<filename>.mp3
//	outbox/sorted/<lang>/<YYYY-??-??>/<filename>.mp3
//	outbox/sorted/<lang>/_no_date/<filename>.mp3
//	outbox/sorted/<lang>/extra/<kind>/<filename>.mp3
//
// Filename body (after stripping `.mp3` and a trailing ` [a1b2c3]` or
// ` [a1b2c3]-N` hash):
//
//	[Tag] — Book Verse — Location — Title   (e.g. "[Праздник] — БГ 16.07 — Бомбей — ...")
//	[Tag] — Location — Title
//	[Tag] — Location
//	Book Verse — Location — Title
//	Book Verse — Location
//	Book — Location
//	Location — Title
//	Location
package canonical

import (
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
)

const (
	authorRu = "Шрила Прабхупада"
	authorEn = "Srila Prabhupada"
)

var (
	pathRE = regexp.MustCompile(
		`(?:^|/)outbox/sorted/(?P<lang>ru|en)/(?P<bucket>extra/[^/]+|_no_date|\d{4}-(?:\d{2}|\?\?)-(?:\d{2}|\?\?))/(?P<filename>[^/]+)$`,
	)

	hashSuffixRE = regexp.MustCompile(`\s*\[[0-9a-f]{6}\](?:-\d+)?$`)

	tagPrefixRE = regexp.MustCompile(`^\[(?P<tag>[^\]]+)\]\s*—\s*`)

	bookVerseRE = regexp.MustCompile(
		`^(?P<book>БГ|ШБ|ЧЧ-Ади|ЧЧ-Мадхйа|ЧЧ-Антйа|Ишопанишад|НП|БС|BG|SB|ISO|NOD|BS|CC_ADI|CC_MADHYA|CC_ANTYA)(?:\s+(?P<verse>\d+(?:\.\d+)*(?:-\d+(?:\.\d+)*)?))?$`,
	)

	dateBucketRE = regexp.MustCompile(`^(\d{4})-(\d{2}|\?\?)-(\d{2}|\?\?)$`)

	bookFromCyrillic = map[string]string{
		"БГ": "BG", "ШБ": "SB",
		"ЧЧ-Ади": "CC_ADI", "ЧЧ-Мадхйа": "CC_MADHYA", "ЧЧ-Антйа": "CC_ANTYA",
		"Ишопанишад": "ISO", "НП": "NOD", "БС": "BS",
	}

	enBookCodes = map[string]bool{
		"BG": true, "SB": true, "ISO": true, "NOD": true, "BS": true,
		"CC_ADI": true, "CC_MADHYA": true, "CC_ANTYA": true,
	}

	// kindFromTag maps the literal `[…]` prefix label to the canonical
	// KindTag slug. Both ru and en variants share the same slug space.
	kindFromTag = map[string]string{
		"Прогулка": "morning_walk", "Walk": "morning_walk", "MW": "morning_walk",
		"Беседа":            "conversation",
		"Conv":              "conversation",
		"Интервью":          "interview",
		"Interview":         "interview",
		"Пресс-конференция": "press_conference",
		"Press-conf":        "press_conference",
		"Речь":              "address",
		"Address":           "address",
		"Вьяса-пуджа":       "vyasa_puja",
		"Vyasa-puja":        "vyasa_puja",
		"Инициация":         "initiation",
		"Initiation":        "initiation",
		"Свадьба":           "wedding",
		"Wedding":           "wedding",
		"Праздник":          "festival",
		"Festival":          "festival",
		"Бхаджан":           "bhajan",
		"Bhajan":            "bhajan",
		"Прочее":            "other",
		"Misc":              "other",
	}

	// validKindSlug guards `extra/<dir>` mapping — only canonical slugs map
	// to a KindTag. Anything else (e.g. extra/lecture for lecture fragments)
	// leaves KindTag empty.
	validKindSlug = map[string]bool{
		"morning_walk": true, "conversation": true, "interview": true,
		"press_conference": true, "address": true, "vyasa_puja": true,
		"initiation": true, "wedding": true, "festival": true,
		"bhajan": true, "other": true,
	}
)

// Parse extracts canonical metadata from absPath into a writable Spec
// the extractor can finish populating (e.g. filename-fallback title)
// before passing through track.NewMetadata. ok=false when the path is
// not under outbox/sorted/<lang>/... or the filename doesn't end with
// .mp3.
func Parse(absPath string) (track.MetadataSpec, bool) {
	p := filepath.ToSlash(absPath)
	pm := pathRE.FindStringSubmatch(p)
	if pm == nil {
		return track.MetadataSpec{}, false
	}
	lang := pm[pathRE.SubexpIndex("lang")]
	bucket := pm[pathRE.SubexpIndex("bucket")]
	fname := pm[pathRE.SubexpIndex("filename")]

	if !strings.HasSuffix(strings.ToLower(fname), ".mp3") {
		return track.MetadataSpec{}, false
	}
	base := fname[:len(fname)-len(".mp3")]

	spec := track.MetadataSpec{
		Languages: []string{lang},
		AuthorRaw: prabhupadaName(lang),
	}

	var kindFromDir string
	switch {
	case strings.HasPrefix(bucket, "extra/"):
		kindFromDir = strings.TrimPrefix(bucket, "extra/")
		if validKindSlug[kindFromDir] {
			spec.KindTag = kindFromDir
		}
	case bucket == "_no_date":
		// date stays nil
	default:
		if dm := dateBucketRE.FindStringSubmatch(bucket); dm != nil {
			year, month, day := dm[1], dm[2], dm[3]
			switch {
			case month != "??" && day != "??":
				if t, err := time.Parse("2006-01-02", year+"-"+month+"-"+day); err == nil {
					spec.Date = &t
				}
			case month != "??":
				if t, err := time.Parse("2006-01-02", year+"-"+month+"-01"); err == nil {
					spec.Date = &t
				}
			}
		}
	}

	base = hashSuffixRE.ReplaceAllString(base, "")
	base = strings.TrimSpace(base)

	if tm := tagPrefixRE.FindStringSubmatch(base); tm != nil {
		tag := tm[tagPrefixRE.SubexpIndex("tag")]
		if slug, ok := kindFromTag[tag]; ok {
			spec.KindTag = slug
		}
		base = strings.TrimSpace(base[len(tm[0]):])
	}

	parts := splitEmDash(base)

	if len(parts) == 0 || (len(parts) == 1 && parts[0] == "") {
		// No usable title parsed — the extractor's filename-fallback path
		// fills it in before construction.
		spec.TitleIsFallback = true
		return spec, true
	}

	// Try book+verse on parts[0].
	if bm := bookVerseRE.FindStringSubmatch(parts[0]); bm != nil {
		bookRaw := bm[bookVerseRE.SubexpIndex("book")]
		verse := bm[bookVerseRE.SubexpIndex("verse")]
		canon, _ := canonicalBook(bookRaw)
		// Strip leading zeros and expand ranges into one RefRaw per verse.
		// Filename `БГ 02.23-24` → two refs ({BG, "2.23"}, {BG, "2.24"}).
		// Each `track_references.tokens` row is a single verse coordinate;
		// downstream (commit, mobile chip rendering) treats them as such.
		for _, t := range expandRange(normalizeTokens(verse)) {
			spec.References = append(spec.References, track.RefRaw{
				SourceCode: canon,
				Tokens:     t,
			})
		}
		if len(parts) >= 2 {
			spec.LocationRaw = parts[1]
		}
		if len(parts) >= 3 {
			spec.Title = strings.Join(parts[2:], " — ")
		}
	} else if len(parts) == 1 {
		// Single non-book part. For _no_date and extras the convention
		// is title-only; for dated lectures it's location-only.
		single := parts[0]
		if bucket == "_no_date" || kindFromDir != "" {
			spec.Title = single
		} else {
			spec.LocationRaw = single
		}
	} else {
		spec.LocationRaw = parts[0]
		spec.Title = strings.Join(parts[1:], " — ")
	}

	if strings.TrimSpace(spec.Title) == "" {
		spec.TitleIsFallback = true
	}
	return spec, true
}

// splitEmDash splits on the canonical " — " separator (em-dash with one
// space on each side) and trims each part.
func splitEmDash(s string) []string {
	raw := strings.Split(s, " — ")
	out := make([]string, 0, len(raw))
	for _, r := range raw {
		if r = strings.TrimSpace(r); r != "" {
			out = append(out, r)
		}
	}
	return out
}

func canonicalBook(raw string) (string, bool) {
	if cy, ok := bookFromCyrillic[raw]; ok {
		return cy, true
	}
	if enBookCodes[raw] {
		return raw, true
	}
	return raw, false
}

func prabhupadaName(lang string) string {
	if lang == "en" {
		return authorEn
	}
	return authorRu
}

// normalizeTokens strips leading zeros from each numeric segment in a verse
// token. Filename convention pads ("БГ 02.03.20"), DB stores semantic shape
// ("2.3.20"). Splits on "." and on "-" within a segment so that range
// suffixes get the same treatment ("06.01.01-02" → "6.1.1-2").
func normalizeTokens(s string) string {
	if s == "" {
		return s
	}
	dotParts := strings.Split(s, ".")
	for i, p := range dotParts {
		// Each dot-part may itself contain a "-" range (e.g. "23-24").
		if strings.Contains(p, "-") {
			rangeParts := strings.Split(p, "-")
			for j, rp := range rangeParts {
				rangeParts[j] = stripLeadingZeros(rp)
			}
			dotParts[i] = strings.Join(rangeParts, "-")
		} else {
			dotParts[i] = stripLeadingZeros(p)
		}
	}
	return strings.Join(dotParts, ".")
}

// stripLeadingZeros removes leading "0" digits but keeps "0" if the segment
// is all zeros. Non-numeric strings pass through unchanged.
func stripLeadingZeros(s string) string {
	if s == "" {
		return s
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return s
		}
	}
	trimmed := strings.TrimLeft(s, "0")
	if trimmed == "" {
		return "0"
	}
	return trimmed
}

// expandRange takes a normalized verse token and returns one entry per
// individual verse: a range in the last numeric segment is expanded.
//
//   "1.15"     → ["1.15"]
//   "2.23-24"  → ["2.23", "2.24"]
//   "6.1.1-2"  → ["6.1.1", "6.1.2"]
//   "3-5"      → ["3", "4", "5"]
//
// If the suffix isn't a single integer (e.g. "1.5-2.7" — cross-section
// range) the input is returned as a single-element slice unchanged: the
// canonical archive doesn't use that form, and silently inventing verses
// would be worse than leaving it for manual review.
func expandRange(s string) []string {
	if !strings.Contains(s, "-") {
		return []string{s}
	}
	dashIdx := strings.LastIndex(s, "-")
	base := s[:dashIdx]
	suffix := s[dashIdx+1:]
	// Suffix must be a plain integer with no further dots.
	if suffix == "" || strings.Contains(suffix, ".") || !isAllDigitsParser(suffix) {
		return []string{s}
	}
	end, err := atoi(suffix)
	if err != nil || end < 0 {
		return []string{s}
	}
	// `base` may itself be "X.Y.Z" or "X". The verse to vary is the last
	// numeric segment of base.
	dotIdx := strings.LastIndex(base, ".")
	prefix := ""
	startStr := base
	if dotIdx >= 0 {
		prefix = base[:dotIdx+1] // includes trailing dot
		startStr = base[dotIdx+1:]
	}
	if !isAllDigitsParser(startStr) {
		return []string{s}
	}
	start, err := atoi(startStr)
	if err != nil || start < 0 || end < start {
		return []string{s}
	}
	out := make([]string, 0, end-start+1)
	for v := start; v <= end; v++ {
		out = append(out, prefix+itoa(v))
	}
	return out
}

func isAllDigitsParser(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// Tiny strconv replacements to keep the package's import surface tight.
func atoi(s string) (int, error) {
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0, errParseInt
		}
		n = n*10 + int(r-'0')
	}
	return n, nil
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

var errParseInt = stringError("not a non-negative integer")

type stringError string

func (e stringError) Error() string { return string(e) }
