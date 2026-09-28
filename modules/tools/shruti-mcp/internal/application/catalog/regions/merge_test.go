package regions

import (
	"errors"
	"testing"
)

func TestUpsertKeepsOptionalFieldsTheInputLeavesOut(t *testing.T) {
	uc := newUC(t)
	seedConfig(t, uc, fullRegionsConfig)

	out, err := uc.Upsert(validRegion("global"))
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	global := regionObjects(t, uc)["global"]
	for field, want := range map[string]string{
		"shareTranscriptUrl":  "https://api.example.com/share/transcripts",
		"profileBaseUrl":      "https://api.example.com",
		"orchestratorBaseUrl": "https://api.example.com",
		"discoveryBaseUrl":    "https://api.example.com",
	} {
		if global[field] != want {
			t.Errorf("%s = %v, want %q kept", field, global[field], want)
		}
	}
	if out.ProfileBaseURL != "https://api.example.com" {
		t.Errorf("returned region lost profileBaseUrl: %+v", out)
	}
}

func TestUpsertClearsTheOptionalFieldsItIsTold(t *testing.T) {
	uc := newUC(t)
	seedConfig(t, uc, fullRegionsConfig)

	if _, err := uc.Upsert(validRegion("global"), "profileBaseUrl", "discoveryBaseUrl"); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	global := regionObjects(t, uc)["global"]
	for _, field := range []string{"profileBaseUrl", "discoveryBaseUrl"} {
		if v, ok := global[field]; ok {
			t.Errorf("%s = %v, want it cleared", field, v)
		}
	}
	if global["orchestratorBaseUrl"] != "https://api.example.com" {
		t.Errorf("orchestratorBaseUrl = %v, want it kept", global["orchestratorBaseUrl"])
	}
}

func TestUpsertRefusesToClearAFieldItIsGiven(t *testing.T) {
	uc := newUC(t)
	seedConfig(t, uc, fullRegionsConfig)
	in := validRegion("global")
	in.ProfileBaseURL = "https://api2.example.com"
	_, err := uc.Upsert(in, "profileBaseUrl")
	var ve *ValidationError
	if !errors.As(err, &ve) || ve.Field != "clear" {
		t.Fatalf("err = %v, want a ValidationError on clear", err)
	}
	if got := regionObjects(t, uc)["global"]["profileBaseUrl"]; got != "https://api.example.com" {
		t.Fatalf("profileBaseUrl = %v, want the region left unchanged", got)
	}
}

func TestUpsertRefusesToClearAFieldItDoesNotKnow(t *testing.T) {
	uc := newUC(t)
	seedConfig(t, uc, fullRegionsConfig)
	for _, field := range []string{"chatBaseUrl", "futureBaseUrl", ""} {
		_, err := uc.Upsert(validRegion("global"), field)
		var ve *ValidationError
		if !errors.As(err, &ve) || ve.Field != "clear" {
			t.Errorf("clear %q: err = %v, want a ValidationError on clear", field, err)
		}
	}
}
