package proactive

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func newUC(t *testing.T) UseCase {
	t.Helper()
	dir := t.TempDir()
	return UseCase{OutDir: dir, Mu: &sync.Mutex{}}
}

func TestGet_emptyWhenFileAbsent(t *testing.T) {
	uc := newUC(t)
	got, err := uc.Get()
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !got.Empty || got.Doc != nil {
		t.Fatalf("want empty=true doc=nil, got %+v", got)
	}
}

func TestHolidayAdd_createsFreshDocAndAtomicallyWrites(t *testing.T) {
	uc := newUC(t)
	res, err := uc.HolidayAdd(HolidayInput{
		ID:   "janmashtami_2026",
		Name: map[string]string{"en": "Janmashtami", "ru": "Джанмаштами"},
		Date: "2026-08-26",
	})
	if err != nil {
		t.Fatalf("HolidayAdd: %v", err)
	}
	if !res.Ok || res.WrittenPath == "" {
		t.Fatalf("bad result: %+v", res)
	}
	// File exists and is valid JSON with expected nesting.
	raw, err := os.ReadFile(res.WrittenPath)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	cals := got["calendars"].(map[string]any)
	holidays := cals["holidays"].([]any)
	if len(holidays) != 1 {
		t.Fatalf("want 1 holiday, got %d", len(holidays))
	}
	h := holidays[0].(map[string]any)
	if h["id"] != "janmashtami_2026" || h["date"] != "2026-08-26" {
		t.Fatalf("bad holiday entry: %+v", h)
	}
	// MkdirAll created the artifacts/catalog/ tree.
	want := filepath.Join(uc.OutDir, "artifacts", "catalog", "proactive.json")
	if res.WrittenPath != want {
		t.Fatalf("path mismatch: got %s want %s", res.WrittenPath, want)
	}
}

func TestHolidayAdd_upsertReplacesById(t *testing.T) {
	uc := newUC(t)
	first := HolidayInput{
		ID:   "gp",
		Name: map[string]string{"en": "Old"},
		Date: "2026-03-13",
	}
	if _, err := uc.HolidayAdd(first); err != nil {
		t.Fatal(err)
	}
	second := HolidayInput{
		ID:   "gp",
		Name: map[string]string{"en": "New Name"},
		Date: "2026-03-13",
	}
	if _, err := uc.HolidayAdd(second); err != nil {
		t.Fatal(err)
	}
	list, err := uc.HolidayList()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("want 1, got %d", len(list))
	}
	name := list[0]["name"].(map[string]any)
	if name["en"] != "New Name" {
		t.Fatalf("upsert didn't replace: %+v", name)
	}
}

func TestHolidayList_sortedByDate(t *testing.T) {
	uc := newUC(t)
	for _, in := range []HolidayInput{
		{ID: "z", Name: map[string]string{"en": "Z"}, Date: "2026-12-01"},
		{ID: "a", Name: map[string]string{"en": "A"}, Date: "2026-01-15"},
		{ID: "m", Name: map[string]string{"en": "M"}, Date: "2026-06-30"},
	} {
		if _, err := uc.HolidayAdd(in); err != nil {
			t.Fatal(err)
		}
	}
	got, _ := uc.HolidayList()
	if len(got) != 3 {
		t.Fatalf("want 3, got %d", len(got))
	}
	if got[0]["id"] != "a" || got[1]["id"] != "m" || got[2]["id"] != "z" {
		t.Fatalf("wrong order: %v %v %v", got[0]["id"], got[1]["id"], got[2]["id"])
	}
}

func TestHolidayRemove_notFound(t *testing.T) {
	uc := newUC(t)
	_, err := uc.HolidayRemove("nope")
	var nfe *NotFoundError
	if err == nil || !asNotFound(err, &nfe) {
		t.Fatalf("want NotFoundError, got %v", err)
	}
}

func asNotFound(err error, target **NotFoundError) bool {
	if e, ok := err.(*NotFoundError); ok {
		*target = e
		return true
	}
	return false
}

func TestValidateHoliday_rejects(t *testing.T) {
	cases := []struct {
		name string
		in   HolidayInput
		want string // substring of error message
	}{
		{"empty id", HolidayInput{Date: "2026-01-01", Name: map[string]string{"en": "x"}}, "id: is required"},
		{"bad id", HolidayInput{ID: "Has Space", Date: "2026-01-01", Name: map[string]string{"en": "x"}}, "id: must match"},
		{"bad date", HolidayInput{ID: "a", Date: "yesterday", Name: map[string]string{"en": "x"}}, "date: must be YYYY-MM-DD"},
		{"invalid calendar date", HolidayInput{ID: "a", Date: "2026-02-30", Name: map[string]string{"en": "x"}}, "date: invalid calendar date"},
		{"empty name", HolidayInput{ID: "a", Date: "2026-01-01"}, "name: must include at least one locale"},
		{"empty name value", HolidayInput{ID: "a", Date: "2026-01-01", Name: map[string]string{"en": ""}}, "name.en: must be non-empty"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateHoliday(tc.in)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v, want substring %q", err, tc.want)
			}
		})
	}
}

func TestValidateRule_rejects(t *testing.T) {
	base := RuleInput{
		ID:                      "holiday",
		Enabled:                 true,
		Mode:                    "pre_baked",
		PrepWindowHours:         48,
		RefreshIfOlderThanHours: 24,
		SessionStrategy:         "new_session",
		CooldownHours:           24,
	}
	cases := []struct {
		name string
		mut  func(r *RuleInput)
		want string
	}{
		{"unknown id", func(r *RuleInput) { r.ID = "made_up" }, "id: must be one of"},
		{"bad mode", func(r *RuleInput) { r.Mode = "stream" }, "mode: must be one of"},
		{"bad strategy", func(r *RuleInput) { r.SessionStrategy = "append" }, "session_strategy: must be one of"},
		{"negative cooldown", func(r *RuleInput) { r.CooldownHours = -1 }, "cooldown_hours: must be >=0"},
		{"bad predicate", func(r *RuleInput) {
			r.Eligibility = []EligibilityInput{{Predicate: "nope", Value: 1}}
		}, "predicate"},
		{"predicate wants bool", func(r *RuleInput) {
			r.Eligibility = []EligibilityInput{{Predicate: "is_subscribed", Value: 1}}
		}, "must be a bool"},
		{"predicate wants number", func(r *RuleInput) {
			r.Eligibility = []EligibilityInput{{Predicate: "current_streak_at_least", Value: true}}
		}, "must be a number"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := base
			tc.mut(&r)
			err := validateRule(r)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v, want substring %q", err, tc.want)
			}
		})
	}
}

func TestRuleSet_replacesByIdAndWritesAllFields(t *testing.T) {
	uc := newUC(t)
	dismiss := 2160
	in := RuleInput{
		ID:                      "smart_library_hint",
		Enabled:                 true,
		Mode:                    "pre_baked",
		PrepWindowHours:         0,
		RefreshIfOlderThanHours: 9999,
		SessionStrategy:         "new_session",
		CooldownHours:           720,
		DismissResetsAfterHours: &dismiss,
		Eligibility: []EligibilityInput{
			{Predicate: "completed_tracks_at_least", Value: 3},
			{Predicate: "is_subscribed", Value: false},
		},
	}
	if _, err := uc.RuleSet(in); err != nil {
		t.Fatal(err)
	}
	// Set again — second call must replace, not append.
	in.CooldownHours = 999
	if _, err := uc.RuleSet(in); err != nil {
		t.Fatal(err)
	}
	rules, _ := uc.RuleList()
	if len(rules) != 1 {
		t.Fatalf("want 1, got %d", len(rules))
	}
	r := rules[0]
	if int(r["cooldown_hours"].(float64)) != 999 {
		t.Fatalf("cooldown not replaced: %v", r["cooldown_hours"])
	}
	if int(r["dismiss_resets_after_hours"].(float64)) != 2160 {
		t.Fatalf("dismiss missing: %v", r["dismiss_resets_after_hours"])
	}
	elig := r["eligibility"].([]any)
	if len(elig) != 2 {
		t.Fatalf("want 2 elig, got %d", len(elig))
	}
}

func TestRuleSet_omitsOptionalsWhenEmpty(t *testing.T) {
	uc := newUC(t)
	in := RuleInput{
		ID:                      "holiday",
		Enabled:                 true,
		Mode:                    "pre_baked",
		PrepWindowHours:         48,
		RefreshIfOlderThanHours: 24,
		SessionStrategy:         "new_session",
		CooldownHours:           24,
	}
	if _, err := uc.RuleSet(in); err != nil {
		t.Fatal(err)
	}
	rules, _ := uc.RuleList()
	if _, has := rules[0]["session_title_template"]; has {
		t.Fatalf("template should be omitted when empty")
	}
	if _, has := rules[0]["dismiss_resets_after_hours"]; has {
		t.Fatalf("dismiss should be omitted when nil")
	}
	if _, has := rules[0]["eligibility"]; has {
		t.Fatalf("eligibility should be omitted when empty")
	}
}

func TestMasterSet_roundTrip(t *testing.T) {
	uc := newUC(t)
	if _, err := uc.MasterSet(false); err != nil {
		t.Fatal(err)
	}
	got, err := uc.Get()
	if err != nil {
		t.Fatal(err)
	}
	if got.Empty {
		t.Fatal("doc should exist after MasterSet")
	}
	if got.Doc["master_enabled"] != false {
		t.Fatalf("master_enabled not flipped: %v", got.Doc["master_enabled"])
	}
}

// Critical: unknown top-level keys (_comment) survive a round-trip. The
// catalog convention is that examples/proactive.json carries a top-level
// `_comment` describing the file; round-tripping through strict structs
// would silently strip it. This test pins the map[string]any behaviour.
func TestRoundTrip_preservesUnknownTopLevelKeys(t *testing.T) {
	uc := newUC(t)
	// Hand-seed a file with _comment.
	dir := filepath.Join(uc.OutDir, "artifacts", "catalog")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	seed := map[string]any{
		"_comment":       "do not remove",
		"master_enabled": true,
		"rules":          []any{},
		"calendars":      map[string]any{"holidays": []any{}},
	}
	body, _ := json.MarshalIndent(seed, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, "proactive.json"), body, 0o644); err != nil {
		t.Fatal(err)
	}
	// Add a holiday — this triggers the load-mutate-save cycle.
	if _, err := uc.HolidayAdd(HolidayInput{
		ID:   "test",
		Name: map[string]string{"en": "T"},
		Date: "2026-01-01",
	}); err != nil {
		t.Fatal(err)
	}
	// Re-read raw and verify _comment is still there.
	raw, err := os.ReadFile(filepath.Join(dir, "proactive.json"))
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got["_comment"] != "do not remove" {
		t.Fatalf("_comment dropped: %v", got["_comment"])
	}
}
