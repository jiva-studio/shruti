package extract

import (
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/jiva-studio/lectorium/discovery/internal/domain"
)

// mediaExt is the set of extensions that make a URL a candidate recording.
// An extension is a fact about the URL, not a guess about the site.
var mediaExt = map[string]bool{
	".mp3": true, ".m4a": true, ".m4b": true, ".aac": true, ".wav": true,
	".ogg": true, ".oga": true, ".opus": true, ".flac": true, ".wma": true,
	".mp4": true, ".m4v": true, ".webm": true,
}

// notPageExt is the set of extensions that make a URL something other than a
// page to read. Downloading one to discover it is not HTML costs its whole
// size: an archive on one site was 8 MB of PowerPoint and a kirtan festival
// packed into a .rar.
var notPageExt = map[string]bool{
	".ppt": true, ".pptx": true, ".doc": true, ".docx": true, ".xls": true,
	".xlsx": true, ".pdf": true, ".rtf": true, ".epub": true, ".djvu": true,
	".zip": true, ".rar": true, ".7z": true, ".gz": true, ".bz2": true,
	".tar": true, ".iso": true, ".exe": true, ".dmg": true, ".apk": true,
	".jpg": true, ".jpeg": true, ".png": true, ".gif": true, ".webp": true,
	".svg": true, ".ico": true, ".bmp": true, ".tif": true, ".tiff": true,
	".css": true, ".js": true, ".woff": true, ".woff2": true, ".ttf": true,
}

// IsMediaURL reports whether a URL points at a media file we could ingest.
func IsMediaURL(raw string) bool {
	return extOf(raw) != "" && mediaExt[extOf(raw)]
}

// IsPageURL reports whether a URL is worth fetching as a page. An extension is
// a fact about the URL, not a guess about the site; anything without one, or
// with one we do not recognise, is still worth a look.
func IsPageURL(raw string) bool {
	ext := extOf(raw)
	return !notPageExt[ext] && !mediaExt[ext]
}

// extOf is the lowercased extension of a URL's path, or "" if it has none.
func extOf(raw string) string {
	p := raw
	if i := strings.IndexAny(p, "?#"); i >= 0 {
		p = p[:i]
	}
	i := strings.LastIndex(p, ".")
	if i < 0 || strings.ContainsAny(p[i:], "/") {
		return ""
	}
	return strings.ToLower(p[i:])
}

// itemsFromMarks turns each media URL found on a page into a record carrying
// its filename and its directory chain.
//
// The text around where the URL appeared is not carried: what a page says about
// a recording is read by the source's own script and handed over labelled.
func itemsFromMarks(marks []mark, pageText, pageURL string) []domain.Item {
	items := make([]domain.Item, 0, len(marks))
	for i, m := range marks {
		it := FromPath(m.url)
		it.PageURL = pageURL
		it.Ordinal = i + 1
		items = append(items, it)
	}
	return items
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:runeStart(s, max)]
}

// runeStart backs an offset up to the start of a character.
//
// These limits are in bytes because the text can be enormous, but a Cyrillic
// or Devanagari letter is several bytes and cutting one in half produces
// something that is not text at all — Postgres rejects it outright, so a long
// Russian transcript would fail to store depending on where the cut landed.
func runeStart(s string, i int) int {
	if i >= len(s) {
		return len(s)
	}
	for i > 0 && !utf8.RuneStart(s[i]) {
		i--
	}
	return i
}

// FromPath builds the raw record for a media URL: the filename and the
// directory chain, nothing interpreted.
//
// Where a source publishes a file tree, the path and filename are the only
// metadata there is. Which segment is the speaker and which is the date is a
// judgement about meaning, so it is left to the normalizer.
func FromPath(mediaURL string) domain.Item {
	it := domain.Item{
		MediaURL: mediaURL,
		Filename: filenameOf(mediaURL),
		Path:     pathOf(mediaURL),
	}
	it.PathSegments = pathSegments(it.Path)
	return it
}

func pathSegments(p string) []string {
	var out []string
	for _, s := range strings.Split(p, "/") {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	if len(out) > 0 {
		out = out[:len(out)-1]
	}
	return out
}

func filenameOf(rawURL string) string {
	p := pathOf(rawURL)
	if i := strings.LastIndex(p, "/"); i >= 0 {
		return p[i+1:]
	}
	return p
}

func pathOf(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	if dec, err := url.PathUnescape(u.EscapedPath()); err == nil {
		return dec
	}
	return u.Path
}
