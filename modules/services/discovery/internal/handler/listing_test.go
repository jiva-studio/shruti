package handler

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/jiva-studio/shruti/discovery/internal/store"
)

func encode(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// The operator console reads these bytes: names, order, and which fields are
// left out when empty.
func TestCollectionsAreEncodedByteForByte(t *testing.T) {
	item := int64(41)
	day := time.Date(1974, 3, 2, 0, 0, 0, 0, time.UTC)
	views := []store.CollectionView{
		{
			ID: 7, SourceID: "a", URL: "https://a.example/c", Title: "Course",
			Description: "Twelve talks", Author: "Radhanath Swami", MemberCount: 2, Pending: 1,
			Members: []store.CollectionMember{
				{Ordinal: 0, ItemID: &item, PageURL: "https://a.example/1", Title: "One",
					MediaURL: "https://a.example/1.mp3", RecordedOn: &day},
				{Ordinal: 1, PageURL: "https://a.example/2"},
			},
		},
		{ID: 8, Title: "Bare"},
	}

	want := `[{"id":7,"source":"a","url":"https://a.example/c","title":"Course",` +
		`"description":"Twelve talks","author":"Radhanath Swami","member_count":2,"members":[` +
		`{"ordinal":0,"item_id":41,"page_url":"https://a.example/1","title":"One",` +
		`"media_url":"https://a.example/1.mp3","recorded_on":"1974-03-02T00:00:00Z"},` +
		`{"ordinal":1,"page_url":"https://a.example/2"}],"pending":1},` +
		`{"id":8,"title":"Bare","member_count":0,"members":null}]`
	if got := encode(t, collectionsFrom(views)); got != want {
		t.Errorf("collections =\n%s\nwant\n%s", got, want)
	}
	if got := encode(t, collectionsFrom(nil)); got != "null" {
		t.Errorf("no collections = %s, want null", got)
	}
}

func TestAuthorsAreEncodedByteForByte(t *testing.T) {
	authors := []store.Author{
		{ID: 3, Name: "Radhanath Swami", Keys: []string{"radhanath swami"},
			Variants: []string{"Radhanath Swami", "HH Radhanath Swami"}, Items: 12},
		{ID: 4, Name: "Unknown", Keys: []string{}, Items: 1},
	}

	want := `[{"id":3,"name":"Radhanath Swami","keys":["radhanath swami"],` +
		`"variants":["Radhanath Swami","HH Radhanath Swami"],"items":12},` +
		`{"id":4,"name":"Unknown","items":1}]`
	if got := encode(t, authorsFrom(authors)); got != want {
		t.Errorf("authors =\n%s\nwant\n%s", got, want)
	}
	if got := encode(t, authorsFrom(nil)); got != "null" {
		t.Errorf("no authors = %s, want null", got)
	}
}
