package index

import "strings"

const (
	// chunkRunes is the target size of one searchable piece. Long enough to
	// hold an argument, short enough that a hit points at a place rather than
	// at a whole page.
	chunkRunes = 1000
	// chunkMinRunes is below which a trailing piece is folded into the one
	// before it instead of standing alone.
	chunkMinRunes = 120
)

// Chunks splits text into searchable pieces on line boundaries.
//
// Splitting on lines rather than at a fixed offset keeps a sentence whole, and
// the flattener already put a newline wherever the page had a block.
func Chunks(text string) []string {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}

	var out []string
	var cur strings.Builder
	curLen := 0

	flush := func() {
		if s := strings.TrimSpace(cur.String()); s != "" {
			out = append(out, s)
		}
		cur.Reset()
		curLen = 0
	}

	for _, line := range strings.Split(text, "\n") {
		lineLen := len([]rune(line))
		if curLen > 0 && curLen+lineLen > chunkRunes {
			flush()
		}
		// A single line longer than a whole chunk is split on words rather
		// than dropped or left to dominate.
		if lineLen > chunkRunes {
			flush()
			out = append(out, splitLong(line)...)
			continue
		}
		if curLen > 0 {
			cur.WriteByte('\n')
			curLen++
		}
		cur.WriteString(line)
		curLen += lineLen
	}
	flush()

	// A short tail says little on its own and searches better attached to what
	// came before it.
	if n := len(out); n > 1 && len([]rune(out[n-1])) < chunkMinRunes {
		out[n-2] += "\n" + out[n-1]
		out = out[:n-1]
	}
	return out
}

func splitLong(line string) []string {
	var out []string
	var cur strings.Builder
	curLen := 0
	for _, word := range strings.Fields(line) {
		wordLen := len([]rune(word))
		if curLen > 0 && curLen+wordLen > chunkRunes {
			out = append(out, cur.String())
			cur.Reset()
			curLen = 0
		}
		if curLen > 0 {
			cur.WriteByte(' ')
			curLen++
		}
		cur.WriteString(word)
		curLen += wordLen
	}
	if cur.Len() > 0 {
		out = append(out, cur.String())
	}
	return out
}
