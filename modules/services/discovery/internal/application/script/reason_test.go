package script_test

import (
	"context"
	"fmt"
	"testing"

	"github.com/jiva-studio/shruti/discovery/internal/application/script"
)

func TestReasonsReachGo(t *testing.T) {
	r, err := script.New()
	if err != nil {
		t.Fatal(err)
	}
	// A line with no speaker at all: the script must say so.
	f := "Some_Recording_Without_Anybody.mp3"
	got, err := r.Run(context.Background(), "idt", script.Page{Path: []string{"06_-_More"}},
		[]script.Item{{URL: "u", Filename: f}})
	if err != nil {
		t.Fatal(err)
	}
	fmt.Printf("complete=%v reasons=%v title=%q\n", got["u"].Complete, got["u"].Reasons, got["u"].Title)
	if got["u"].Complete {
		t.Fatal("expected the script to give up on a line naming nobody")
	}
	if len(got["u"].Reasons) == 0 {
		t.Error("gave up without saying why")
	}
}
