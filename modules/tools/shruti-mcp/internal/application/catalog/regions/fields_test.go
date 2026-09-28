package regions

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
)

const fullRegionsConfig = `{"regions":[
  {"id":"global","name":"Global","urlTemplate":"https://cdn.example.com/{path}",
   "shareAudioUrl":"https://api.example.com/share/audio/excerpts",
   "shareVideoUrl":"https://api.example.com/share/video/reels",
   "shareTranscriptUrl":"https://api.example.com/share/transcripts",
   "authBaseUrl":"https://api.example.com/auth","chatBaseUrl":"https://api.example.com",
   "profileBaseUrl":"https://api.example.com","orchestratorBaseUrl":"https://api.example.com",
   "discoveryBaseUrl":"https://api.example.com",
   "futureBaseUrl":"https://api.example.com/future","futureFlags":{"beta":true,"weight":3}},
  {"id":"regional","name":"Regional","urlTemplate":"https://edge.example.com/{path}",
   "shareAudioUrl":"https://edge.example.com/share/audio/excerpts",
   "shareVideoUrl":"https://edge.example.com/share/video/reels",
   "shareTranscriptUrl":"https://edge.example.com/share/transcripts",
   "authBaseUrl":"https://edge.example.com/auth","chatBaseUrl":"https://edge.example.com",
   "discoveryBaseUrl":"https://edge.example.com","futureBaseUrl":"https://edge.example.com/future"}
]}`

// regionObjects reads the regions list from disk as raw JSON objects, so a
// field the Region type does not model is still visible.
func regionObjects(t *testing.T, uc UseCase) map[string]map[string]any {
	t.Helper()
	var list []map[string]any
	if err := json.Unmarshal(readConfig(t, uc)["regions"], &list); err != nil {
		t.Fatalf("regions not a list of objects: %v", err)
	}
	out := map[string]map[string]any{}
	for _, r := range list {
		out[r["id"].(string)] = r
	}
	return out
}

func seededObjects(t *testing.T) map[string]map[string]any {
	t.Helper()
	var doc struct {
		Regions []map[string]any `json:"regions"`
	}
	if err := json.Unmarshal([]byte(fullRegionsConfig), &doc); err != nil {
		t.Fatal(err)
	}
	out := map[string]map[string]any{}
	for _, r := range doc.Regions {
		out[r["id"].(string)] = r
	}
	return out
}

func TestUpsertLeavesEveryFieldOfTheOtherRegions(t *testing.T) {
	uc := newUC(t)
	seedConfig(t, uc, fullRegionsConfig)

	if _, err := uc.Upsert(validRegion("added")); err != nil {
		t.Fatalf("upsert: %v", err)
	}

	got := regionObjects(t, uc)
	want := seededObjects(t)
	for _, id := range []string{"global", "regional"} {
		if !reflect.DeepEqual(got[id], want[id]) {
			t.Errorf("region %s changed:\n got  %v\n want %v", id, got[id], want[id])
		}
	}
}

func TestUpsertKeepsTheFieldsItDoesNotModel(t *testing.T) {
	uc := newUC(t)
	seedConfig(t, uc, fullRegionsConfig)

	in := validRegion("global")
	in.ShareTranscriptURL = "https://api2.example.com/share/transcripts"
	in.DiscoveryBaseURL = "https://api2.example.com"
	if _, err := uc.Upsert(in); err != nil {
		t.Fatalf("upsert: %v", err)
	}

	global := regionObjects(t, uc)["global"]
	if global["futureBaseUrl"] != "https://api.example.com/future" {
		t.Errorf("futureBaseUrl = %v", global["futureBaseUrl"])
	}
	if !reflect.DeepEqual(global["futureFlags"], map[string]any{"beta": true, "weight": float64(3)}) {
		t.Errorf("futureFlags = %v", global["futureFlags"])
	}
	if global["shareTranscriptUrl"] != "https://api2.example.com/share/transcripts" {
		t.Errorf("shareTranscriptUrl = %v", global["shareTranscriptUrl"])
	}
	if global["discoveryBaseUrl"] != "https://api2.example.com" {
		t.Errorf("discoveryBaseUrl = %v", global["discoveryBaseUrl"])
	}
	if global["authBaseUrl"] != "https://host.example.com/auth" {
		t.Errorf("authBaseUrl = %v, want the upserted value", global["authBaseUrl"])
	}
}

func TestRemoveLeavesEveryFieldOfTheRemainingRegions(t *testing.T) {
	uc := newUC(t)
	seedConfig(t, uc, fullRegionsConfig)

	if _, err := uc.Remove("regional"); err != nil {
		t.Fatalf("remove: %v", err)
	}

	got := regionObjects(t, uc)
	if _, ok := got["regional"]; ok {
		t.Fatal("regional still listed")
	}
	if want := seededObjects(t)["global"]; !reflect.DeepEqual(got["global"], want) {
		t.Errorf("global changed:\n got  %v\n want %v", got["global"], want)
	}
}

func TestGetReturnsEveryField(t *testing.T) {
	uc := newUC(t)
	seedConfig(t, uc, fullRegionsConfig)

	r, err := uc.Get("global")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	b, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if want := seededObjects(t)["global"]; !reflect.DeepEqual(got, want) {
		t.Errorf("get:\n got  %v\n want %v", got, want)
	}
}

func TestUpsertRequiresHTTPSForTheOptionalShareAndDiscoveryURLs(t *testing.T) {
	cases := map[string]func(*Region){
		"shareTranscriptUrl": func(r *Region) { r.ShareTranscriptURL = "http://api.example.com/share/transcripts" },
		"discoveryBaseUrl":   func(r *Region) { r.DiscoveryBaseURL = "http://api.example.com" },
	}
	for field, mutate := range cases {
		t.Run(field, func(t *testing.T) {
			uc := newUC(t)
			in := validRegion("global")
			mutate(&in)
			_, err := uc.Upsert(in)
			var ve *ValidationError
			if !errors.As(err, &ve) || ve.Field != field {
				t.Fatalf("err = %v, want a ValidationError on %s", err, field)
			}
		})
	}
}
