package script_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/jiva-studio/shruti/discovery/internal/application/script"
)

// A channel does not always answer with its videos. Some answer with their
// tabs — Videos, Live, Shorts — and a tab's id is the channel's own. Building a
// watch address out of that gave three addresses to nowhere, and four channels
// were configured, read, and never walked.

func ytLinks(t *testing.T, doc any) []string {
	t.Helper()
	r, err := script.New()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	got, err := r.Links(context.Background(), "youtube",
		script.Page{URL: "https://www.youtube.com/channel/UCchannel", HTML: string(raw)})
	if err != nil {
		t.Fatal(err)
	}
	if !got.Answered {
		t.Fatal("the script did not answer")
	}
	return got.URLs
}

func TestAChannelAnsweringWithTabsIsWalked(t *testing.T) {
	got := ytLinks(t, map[string]any{
		"_type": "playlist",
		"id":    "UCchannel",
		"entries": []map[string]any{
			{"_type": "playlist", "id": "UCchannel", "title": "Goswami - Videos",
				"webpage_url": "https://www.youtube.com/channel/UCchannel/videos"},
			{"_type": "playlist", "id": "UCchannel", "title": "Goswami - Live",
				"webpage_url": "https://www.youtube.com/channel/UCchannel/streams"},
		},
	})
	want := []string{
		"https://www.youtube.com/channel/UCchannel/videos",
		"https://www.youtube.com/channel/UCchannel/streams",
	}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("= %q, want %q", got, want)
	}
	for _, u := range got {
		if strings.Contains(u, "watch?v=UC") {
			t.Errorf("a channel id was built into a watch address: %q", u)
		}
	}
}

// Vertical clips are not lectures, and a channel read whole offers them as a
// tab of their own.
func TestTheShortsTabIsSkipped(t *testing.T) {
	got := ytLinks(t, map[string]any{
		"_type": "playlist",
		"entries": []map[string]any{
			{"_type": "playlist", "webpage_url": "https://www.youtube.com/channel/UCchannel/videos"},
			{"_type": "playlist", "webpage_url": "https://www.youtube.com/channel/UCchannel/shorts"},
		},
	})
	if len(got) != 1 || !strings.HasSuffix(got[0], "/videos") {
		t.Errorf("= %q", got)
	}
}

func TestAChannelAnsweringWithVideosKeepsTheirAddresses(t *testing.T) {
	got := ytLinks(t, map[string]any{
		"_type": "playlist",
		"entries": []map[string]any{
			{"_type": "url", "id": "Nmxm64L2CK0", "url": "https://www.youtube.com/watch?v=Nmxm64L2CK0"},
			{"_type": "url", "id": "SYnHBUWHfkA", "url": "https://www.youtube.com/watch?v=SYnHBUWHfkA"},
			// An entry with neither address is nothing to visit.
			{"_type": "url", "id": "orphan"},
		},
	})
	want := []string{
		"https://www.youtube.com/watch?v=Nmxm64L2CK0",
		"https://www.youtube.com/watch?v=SYnHBUWHfkA",
	}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("= %q, want %q", got, want)
	}
}

// A video page is the recording, at the address it was read from.
func TestAVideoIsTheAddressItWasReadFrom(t *testing.T) {
	r, err := script.New()
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]any{"id": "Nmxm64L2CK0", "title": "Лекция"})
	got, err := r.Recordings(context.Background(), "youtube",
		script.Page{URL: "https://www.youtube.com/watch?v=Nmxm64L2CK0", HTML: string(raw)})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.URLs) != 1 || got.URLs[0] != "https://www.youtube.com/watch?v=Nmxm64L2CK0" {
		t.Errorf("= %q", got.URLs)
	}
}

// A tab is a list, not a recording.
func TestATabIsNotARecording(t *testing.T) {
	r, _ := script.New()
	raw, _ := json.Marshal(map[string]any{"_type": "playlist", "id": "UCchannel", "entries": []any{}})
	got, err := r.Recordings(context.Background(), "youtube",
		script.Page{URL: "https://www.youtube.com/channel/UCchannel/videos", HTML: string(raw)})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.URLs) != 0 {
		t.Errorf("= %q", got.URLs)
	}
}
