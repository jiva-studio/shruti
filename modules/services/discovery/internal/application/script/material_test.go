package script_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/jiva-studio/shruti/discovery/internal/application/script"
)

// A script that cannot read a line hands over what it was looking at. Without
// that, a recording reaches the model as two URLs and nothing else.

func TestTheVideoTitleIsHandedOverRatherThanKept(t *testing.T) {
	r, err := script.New()
	if err != nil {
		t.Fatal(err)
	}
	const url = "https://www.youtube.com/watch?v=vid"
	raw, _ := json.Marshal(map[string]any{
		"id":      "vid",
		"title":   "Е.М. Сарвагья прабху. ШБ 9.10.12. Уроки Рама-лилы. 4.01.2025. Хампи",
		"channel": "Goswami",
	})

	got, err := r.Run(context.Background(), "youtube",
		script.Page{URL: url, HTML: string(raw)}, []script.Item{{URL: url}})
	if err != nil {
		t.Fatal(err)
	}
	f := got[url]

	// The line holds a speaker, a passage, a name, a date and a place, so none
	// of it is the name of the talk.
	if f.Title != "" {
		t.Errorf("title = %q, want empty: the label is material, not a name", f.Title)
	}
	byLabel := map[string]string{}
	for _, m := range f.Material {
		byLabel[m.Label] = m.Text
	}
	if byLabel["video title"] == "" {
		t.Error("the title was dropped instead of handed over")
	}
	if byLabel["published on the channel"] != "Goswami" {
		t.Errorf("channel = %q, want Goswami", byLabel["published on the channel"])
	}
}

// Which language was spoken is not which languages have subtitles. An uploader
// who adds an English track to a Russian talk publishes "en", and the reader
// hands published tracks over in alphabetical order, so the first of them says
// nothing about the talk. A machine track does: the reader picks it by the
// site's own mark for the original.
func TestPublishedSubtitlesDoNotDecideWhatWasSpoken(t *testing.T) {
	const url = "https://www.youtube.com/watch?v=vid"
	captions := func(cs ...map[string]string) string {
		raw, _ := json.Marshal(map[string]any{
			"id": "vid", "title": "Урок", "channel": "Гаура СПб",
			"language": "ru-RU", "_captions": cs,
		})
		return string(raw)
	}
	const words = `{"events":[{"segs":[{"utf8":"hello"}]}]}`

	for name, tc := range map[string]struct {
		doc  string
		want string
	}{
		"english subtitles on a russian talk": {
			doc:  captions(map[string]string{"lang": "en", "origin": "published", "json3": words}),
			want: "ru",
		},
		"the machine track is believed": {
			doc:  captions(map[string]string{"lang": "en", "origin": "auto", "json3": words}),
			want: "en",
		},
		"a regional track is a language": {
			doc:  captions(map[string]string{"lang": "pt-BR", "origin": "auto", "json3": words}),
			want: "pt",
		},
		"nothing published, nothing heard": {
			doc:  captions(),
			want: "ru",
		},
	} {
		t.Run(name, func(t *testing.T) {
			r, err := script.New()
			if err != nil {
				t.Fatal(err)
			}
			got, err := r.Run(context.Background(), "youtube",
				script.Page{URL: url, HTML: tc.doc}, []script.Item{{URL: url}})
			if err != nil {
				t.Fatal(err)
			}
			if got[url].Language != tc.want {
				t.Errorf("language = %q, want %q", got[url].Language, tc.want)
			}
		})
	}
}

// When a video was posted is handed to the model rather than settled here. It
// is when the talk was given only where the name says nothing else, and which
// of those this is can be read off the name.
func TestWhenAVideoWasPostedIsHandedOver(t *testing.T) {
	r, err := script.New()
	if err != nil {
		t.Fatal(err)
	}
	const url = "https://www.youtube.com/watch?v=vid"
	raw, _ := json.Marshal(map[string]any{
		"id": "vid", "title": "Лекция 1972 года", "channel": "Гаура СПб",
		"upload_date": "20190304",
	})
	got, err := r.Run(context.Background(), "youtube",
		script.Page{URL: url, HTML: string(raw)}, []script.Item{{URL: url}})
	if err != nil {
		t.Fatal(err)
	}
	f := got[url]

	var posted string
	for _, m := range f.Material {
		if m.Label == "published on" {
			posted = m.Text
		}
	}
	if posted != "2019-03-04" {
		t.Errorf("the model was not shown when it was posted: %+v", f.Material)
	}
	// Kept as well, so a file the model passed over still carries a date.
	if f.Date != "2019-03-04" {
		t.Errorf("date = %q", f.Date)
	}
}
