package openaicompatreview

import (
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/jiva-studio/shruti/pipeline/ports/review"
)

const endsMarker = "ENDS"

// parseLines turns the line format back into the full-chunk shape the rest of
// the pipeline expects: every requested segment present, and sentence groups
// rebuilt from their end boundaries.
//
// The reply is a delta, so an idx the model left out is not an error — it
// means "unchanged" and is filled from the request. Lines that match nothing
// are skipped rather than fatal: a stray apology should cost a chunk nothing,
// while a genuinely broken reply still fails on the boundary checks below.
// ParseLines is exported for the batch path, which receives the same line
// format from a job reply instead of a live call.
func ParseLines(body string, sent []review.ChunkSegment) ([]review.ChunkSegment, [][]int, error) {
	if len(sent) == 0 {
		return nil, nil, fmt.Errorf("lines: no segments were sent")
	}
	want := make(map[int]int, len(sent))
	for i, s := range sent {
		want[s.Idx] = i
	}

	out := make([]review.ChunkSegment, len(sent))
	copy(out, sent)

	var ends []int
	inEnds := false
	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "```") {
			continue
		}
		if strings.EqualFold(line, endsMarker) {
			inEnds = true
			continue
		}
		if inEnds {
			ends = append(ends, parseIdxList(line)...)
			continue
		}
		head, rest, ok := strings.Cut(line, "|")
		if !ok {
			continue
		}
		idx, err := strconv.Atoi(strings.TrimSpace(head))
		if err != nil {
			continue
		}
		pos, ok := want[idx]
		if !ok {
			return nil, nil, fmt.Errorf("lines: idx %d was not in the chunk", idx)
		}
		out[pos].Text = strings.TrimSpace(rest)
	}

	groups, err := groupsFromEnds(ends, sent)
	if err != nil {
		return nil, nil, err
	}
	return out, groups, nil
}

func parseIdxList(line string) []int {
	var out []int
	for _, f := range strings.Split(line, ",") {
		if n, err := strconv.Atoi(strings.TrimSpace(f)); err == nil {
			out = append(out, n)
		}
	}
	return out
}

// groupsFromEnds rebuilds sentence groups from their last-idx boundaries.
// Sentences are runs of consecutive segments, so the boundaries carry the
// whole grouping; expanding here keeps BuildEndSet and every downstream
// consumer working on the shape they already know.
func groupsFromEnds(ends []int, sent []review.ChunkSegment) ([][]int, error) {
	if len(ends) == 0 {
		return nil, fmt.Errorf("lines: no %s section", endsMarker)
	}
	known := make(map[int]bool, len(sent))
	for _, s := range sent {
		known[s.Idx] = true
	}
	seen := make(map[int]bool, len(ends))
	cleaned := make([]int, 0, len(ends))
	for _, e := range ends {
		if !known[e] {
			return nil, fmt.Errorf("lines: boundary %d was not in the chunk", e)
		}
		if seen[e] {
			continue
		}
		seen[e] = true
		cleaned = append(cleaned, e)
	}
	last := sent[len(sent)-1].Idx
	if !seen[last] {
		return nil, fmt.Errorf("lines: last idx %d is not a boundary", last)
	}
	sort.Ints(cleaned)

	groups := make([][]int, 0, len(cleaned))
	cur := make([]int, 0, len(sent))
	next := 0
	for _, s := range sent {
		cur = append(cur, s.Idx)
		if next < len(cleaned) && s.Idx == cleaned[next] {
			groups = append(groups, cur)
			cur = make([]int, 0, len(sent))
			next++
		}
	}
	return groups, nil
}
