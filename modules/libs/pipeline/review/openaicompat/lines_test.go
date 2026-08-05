package openaicompatreview

import (
	"reflect"
	"strings"
	"testing"

	"github.com/jiva-studio/lectorium/pipeline/ports/review"
)

func chunk(idx ...int) []review.ChunkSegment {
	out := make([]review.ChunkSegment, len(idx))
	for i, n := range idx {
		out[i] = review.ChunkSegment{Idx: n, Text: "raw" + string(rune('a'+i))}
	}
	return out
}

func TestParseLinesFillsUnreportedFromRequest(t *testing.T) {
	sent := chunk(10, 11, 12, 13, 14)
	segs, groups, err := ParseLines("11|Шри Прабхупада говорил.\nENDS\n11,14", sent)
	if err != nil {
		t.Fatal(err)
	}
	if len(segs) != 5 {
		t.Fatalf("segments = %d, want 5", len(segs))
	}
	if segs[1].Text != "Шри Прабхупада говорил." {
		t.Errorf("idx 11 = %q, want the corrected text", segs[1].Text)
	}
	for _, i := range []int{0, 2, 3, 4} {
		if segs[i].Text != sent[i].Text {
			t.Errorf("idx %d = %q, want the request text %q untouched",
				segs[i].Idx, segs[i].Text, sent[i].Text)
		}
	}
	want := [][]int{{10, 11}, {12, 13, 14}}
	if !reflect.DeepEqual(groups, want) {
		t.Errorf("groups = %v, want %v", groups, want)
	}
}

// An empty delta is a legitimate answer: the chunk needed no correction.
func TestParseLinesAcceptsEmptyDelta(t *testing.T) {
	sent := chunk(0, 1, 2)
	segs, groups, err := ParseLines("ENDS\n2", sent)
	if err != nil {
		t.Fatal(err)
	}
	for i := range segs {
		if segs[i].Text != sent[i].Text {
			t.Errorf("idx %d was altered", segs[i].Idx)
		}
	}
	if !reflect.DeepEqual(groups, [][]int{{0, 1, 2}}) {
		t.Errorf("groups = %v, want one group covering the chunk", groups)
	}
}

func TestParseLinesIgnoresNoise(t *testing.T) {
	sent := chunk(4, 5)
	body := "```\nSure, here is the corrected chunk:\n4|Первое предложение.\n" +
		"not a segment line\nENDS\n5\n```"
	segs, groups, err := ParseLines(body, sent)
	if err != nil {
		t.Fatal(err)
	}
	if segs[0].Text != "Первое предложение." {
		t.Errorf("idx 4 = %q", segs[0].Text)
	}
	if !reflect.DeepEqual(groups, [][]int{{4, 5}}) {
		t.Errorf("groups = %v", groups)
	}
}

// The pipe is the field separator, so text may not contain one; everything
// after the first pipe is text, including further pipes.
func TestParseLinesKeepsTextAfterFirstPipe(t *testing.T) {
	sent := chunk(7)
	segs, _, err := ParseLines("7|a|b\nENDS\n7", sent)
	if err != nil {
		t.Fatal(err)
	}
	if segs[0].Text != "a|b" {
		t.Errorf("text = %q, want %q", segs[0].Text, "a|b")
	}
}

func TestParseLinesRejects(t *testing.T) {
	sent := chunk(1, 2, 3)
	for _, tc := range []struct{ name, body, want string }{
		{"no ends section", "2|Текст.", "no ENDS section"},
		{"boundary outside chunk", "ENDS\n2,9", "boundary 9"},
		{"last idx not a boundary", "ENDS\n2", "last idx 3"},
		{"segment outside chunk", "9|Чужой.\nENDS\n3", "idx 9 was not in the chunk"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, _, err := ParseLines(tc.body, sent)
			if err == nil {
				t.Fatalf("want an error mentioning %q, got none", tc.want)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error = %q, want it to mention %q", err, tc.want)
			}
		})
	}
}

// Boundaries decide where sentences end, so a duplicate or out-of-order list
// must still yield ascending, non-overlapping groups.
func TestGroupsFromEndsNormalises(t *testing.T) {
	sent := chunk(0, 1, 2, 3)
	_, groups, err := ParseLines("ENDS\n3,1,1", sent)
	if err != nil {
		t.Fatal(err)
	}
	want := [][]int{{0, 1}, {2, 3}}
	if !reflect.DeepEqual(groups, want) {
		t.Errorf("groups = %v, want %v", groups, want)
	}
}
