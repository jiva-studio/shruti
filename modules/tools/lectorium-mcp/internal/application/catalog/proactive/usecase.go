// Package proactive owns the `proactive` section of the local config.json
// (see package configdoc) — the editable source-of-truth that
// catalog.config.publish / catalog.publish push into the published
// config.json. The mobile app fetches that config and uses the `proactive`
// block for its agent-initiated chat features (rule overrides + holiday
// calendar + master kill switch).
//
// The section is parsed/serialized through `map[string]any` so unknown /
// forward-compatible keys survive round-trips. Strict structs would drop them.
package proactive

import (
	"fmt"
	"regexp"
	"slices"
	"sort"
	"sync"
	"time"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/catalog/configdoc"
)

// Allowed enum values mirror modules/libs/domain/config.ts:23-92 on the
// mobile side. If the mobile-side union grows, this list must grow too —
// otherwise valid wire-format rule_set calls would be rejected here.
var (
	AllowedRuleIDs = []string{
		"holiday",
		"weekly_digest",
		"inactivity",
		"enable_notifications_hint",
		"smart_library_hint",
		"next_shloka",
	}
	AllowedModes             = []string{"pre_baked", "lazy"}
	AllowedSessionStrategies = []string{"new_session", "append_current", "system_session"}
	AllowedPredicates        = []string{
		"current_streak_at_least",
		"completed_tracks_at_least",
		"total_listened_seconds_at_least",
		"days_since_install_at_least",
		"has_notifications_permission",
		"is_subscribed",
	}
)

var (
	slugRe = regexp.MustCompile(`^[a-z0-9_]+$`)
	dateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
)

// ValidationError carries the offending field path so the MCP layer can
// surface it under `error.details.field`.
type ValidationError struct {
	Field   string
	Message string
}

func (e *ValidationError) Error() string {
	return fmt.Sprintf("%s: %s", e.Field, e.Message)
}

// NotFoundError signals an `id` that doesn't exist on the targeted list.
type NotFoundError struct {
	Entity string
	Key    string
}

func (e *NotFoundError) Error() string {
	return fmt.Sprintf("%s %q not found", e.Entity, e.Key)
}

// UseCase is the application-layer façade. All mutating methods take
// `Mu` so concurrent MCP-tool invocations and `catalog.publish` don't
// interleave reads / writes on the same file.
type UseCase struct {
	OutDir string
	Mu     *sync.Mutex
}

func (u UseCase) store() configdoc.Store {
	return configdoc.Store{OutDir: u.OutDir, Mu: u.Mu}
}

// load returns the `proactive` sub-document of the local config.json. Returns
// `(nil, false, nil)` when config.json is absent OR carries no proactive
// section (so callers seed a fresh doc).
func (u UseCase) load() (map[string]any, bool, error) {
	doc, ok, err := u.store().Load()
	if err != nil || !ok {
		return nil, false, err
	}
	raw, present := doc["proactive"]
	if !present {
		return nil, false, nil
	}
	m, isMap := raw.(map[string]any)
	if !isMap {
		return nil, false, fmt.Errorf("config.json proactive is not an object")
	}
	return m, true, nil
}

// save merges the proactive sub-doc into config.json (preserving regions and
// any other top-level keys) and returns the config.json path. The CRUD tools
// only edit this local file; catalog.config.publish / catalog.publish push it.
func (u UseCase) save(proactiveDoc map[string]any) (string, error) {
	doc, _, err := u.store().Load()
	if err != nil {
		return "", err
	}
	if doc == nil {
		doc = map[string]any{}
	}
	doc["proactive"] = proactiveDoc
	return u.store().Save(doc)
}

// freshDoc seeds a brand-new proactive.json with sensible defaults so a
// `master_set` or `holiday_add` on an empty OutDir produces a valid file.
func freshDoc() map[string]any {
	return map[string]any{
		"master_enabled": true,
		"rules":          []any{},
		"calendars": map[string]any{
			"holidays": []any{},
		},
	}
}

// WriteResult is the envelope payload for every mutating tool.
type WriteResult struct {
	Ok          bool   `json:"ok"`
	WrittenPath string `json:"written_path"`
}

// GetResult is the payload for `catalog.proactive.get`. When the file is
// absent the caller sees `{empty: true}` rather than a synthesized empty doc.
type GetResult struct {
	Empty bool           `json:"empty,omitempty"`
	Doc   map[string]any `json:"doc,omitempty"`
}

// Get returns the parsed document, or `{empty: true}` if no file on disk.
func (u UseCase) Get() (*GetResult, error) {
	m, exists, err := u.load()
	if err != nil {
		return nil, err
	}
	if !exists {
		return &GetResult{Empty: true}, nil
	}
	return &GetResult{Doc: m}, nil
}

// MasterSet flips the top-level kill switch and creates the file if absent.
func (u UseCase) MasterSet(enabled bool) (*WriteResult, error) {
	u.Mu.Lock()
	defer u.Mu.Unlock()
	doc, _, err := u.load()
	if err != nil {
		return nil, err
	}
	if doc == nil {
		doc = freshDoc()
	}
	doc["master_enabled"] = enabled
	path, err := u.save(doc)
	if err != nil {
		return nil, err
	}
	return &WriteResult{Ok: true, WrittenPath: path}, nil
}

// HolidayInput captures the wire-format payload for `holiday_add`.
type HolidayInput struct {
	ID   string
	Name map[string]string
	Date string
}

func (u UseCase) HolidayAdd(in HolidayInput) (*WriteResult, error) {
	if err := validateHoliday(in); err != nil {
		return nil, err
	}
	u.Mu.Lock()
	defer u.Mu.Unlock()
	doc, _, err := u.load()
	if err != nil {
		return nil, err
	}
	if doc == nil {
		doc = freshDoc()
	}
	holidays := getHolidays(doc)
	entry := map[string]any{
		"id":   in.ID,
		"name": stringMapToAny(in.Name),
		"date": in.Date,
	}
	replaced := false
	for i, h := range holidays {
		if hm, ok := h.(map[string]any); ok {
			if id, _ := hm["id"].(string); id == in.ID {
				holidays[i] = entry
				replaced = true
				break
			}
		}
	}
	if !replaced {
		holidays = append(holidays, entry)
	}
	setHolidays(doc, holidays)
	path, err := u.save(doc)
	if err != nil {
		return nil, err
	}
	return &WriteResult{Ok: true, WrittenPath: path}, nil
}

func (u UseCase) HolidayRemove(id string) (*WriteResult, error) {
	u.Mu.Lock()
	defer u.Mu.Unlock()
	doc, exists, err := u.load()
	if err != nil {
		return nil, err
	}
	if !exists || doc == nil {
		return nil, &NotFoundError{Entity: "holiday", Key: id}
	}
	holidays := getHolidays(doc)
	next := make([]any, 0, len(holidays))
	removed := false
	for _, h := range holidays {
		if hm, ok := h.(map[string]any); ok {
			if hid, _ := hm["id"].(string); hid == id {
				removed = true
				continue
			}
		}
		next = append(next, h)
	}
	if !removed {
		return nil, &NotFoundError{Entity: "holiday", Key: id}
	}
	setHolidays(doc, next)
	path, err := u.save(doc)
	if err != nil {
		return nil, err
	}
	return &WriteResult{Ok: true, WrittenPath: path}, nil
}

// HolidayList returns the calendar entries sorted by date (ascending) so
// CLI output is deterministic.
func (u UseCase) HolidayList() ([]map[string]any, error) {
	doc, _, err := u.load()
	if err != nil {
		return nil, err
	}
	if doc == nil {
		return []map[string]any{}, nil
	}
	holidays := getHolidays(doc)
	out := make([]map[string]any, 0, len(holidays))
	for _, h := range holidays {
		if hm, ok := h.(map[string]any); ok {
			out = append(out, hm)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		di, _ := out[i]["date"].(string)
		dj, _ := out[j]["date"].(string)
		return di < dj
	})
	return out, nil
}

// RuleInput captures the wire-format payload for `rule_set`. Optional
// fields are pointer-/zero-typed so the MCP layer can distinguish
// "omitted" from "explicitly zero". On the mobile side the override
// REPLACES the bundled default wholesale (registry.ts:117), so callers
// must pass the full object.
type RuleInput struct {
	ID                      string
	Enabled                 bool
	Mode                    string
	PrepWindowHours         int
	RefreshIfOlderThanHours int
	SessionStrategy         string
	SessionTitleTemplate    string
	CooldownHours           int
	DismissResetsAfterHours *int
	Eligibility             []EligibilityInput
}

// EligibilityInput keeps Value as `any` because the wire type is a
// discriminated union over the predicate name — some predicates carry a
// number, two carry a bool. The validator enforces the shape.
type EligibilityInput struct {
	Predicate string
	Value     any
}

func (u UseCase) RuleSet(in RuleInput) (*WriteResult, error) {
	if err := validateRule(in); err != nil {
		return nil, err
	}
	u.Mu.Lock()
	defer u.Mu.Unlock()
	doc, _, err := u.load()
	if err != nil {
		return nil, err
	}
	if doc == nil {
		doc = freshDoc()
	}
	rules := getRules(doc)
	entry := buildRuleEntry(in)
	replaced := false
	for i, r := range rules {
		if rm, ok := r.(map[string]any); ok {
			if id, _ := rm["id"].(string); id == in.ID {
				rules[i] = entry
				replaced = true
				break
			}
		}
	}
	if !replaced {
		rules = append(rules, entry)
	}
	doc["rules"] = rules
	path, err := u.save(doc)
	if err != nil {
		return nil, err
	}
	return &WriteResult{Ok: true, WrittenPath: path}, nil
}

func (u UseCase) RuleRemove(id string) (*WriteResult, error) {
	u.Mu.Lock()
	defer u.Mu.Unlock()
	doc, exists, err := u.load()
	if err != nil {
		return nil, err
	}
	if !exists || doc == nil {
		return nil, &NotFoundError{Entity: "rule", Key: id}
	}
	rules := getRules(doc)
	next := make([]any, 0, len(rules))
	removed := false
	for _, r := range rules {
		if rm, ok := r.(map[string]any); ok {
			if rid, _ := rm["id"].(string); rid == id {
				removed = true
				continue
			}
		}
		next = append(next, r)
	}
	if !removed {
		return nil, &NotFoundError{Entity: "rule", Key: id}
	}
	doc["rules"] = next
	path, err := u.save(doc)
	if err != nil {
		return nil, err
	}
	return &WriteResult{Ok: true, WrittenPath: path}, nil
}

func (u UseCase) RuleList() ([]map[string]any, error) {
	doc, _, err := u.load()
	if err != nil {
		return nil, err
	}
	if doc == nil {
		return []map[string]any{}, nil
	}
	rules := getRules(doc)
	out := make([]map[string]any, 0, len(rules))
	for _, r := range rules {
		if rm, ok := r.(map[string]any); ok {
			out = append(out, rm)
		}
	}
	return out, nil
}

// ---- helpers ----

func buildRuleEntry(in RuleInput) map[string]any {
	e := map[string]any{
		"id":                          in.ID,
		"enabled":                     in.Enabled,
		"mode":                        in.Mode,
		"prep_window_hours":           in.PrepWindowHours,
		"refresh_if_older_than_hours": in.RefreshIfOlderThanHours,
		"session_strategy":            in.SessionStrategy,
		"cooldown_hours":              in.CooldownHours,
	}
	if in.SessionTitleTemplate != "" {
		e["session_title_template"] = in.SessionTitleTemplate
	}
	if in.DismissResetsAfterHours != nil {
		e["dismiss_resets_after_hours"] = *in.DismissResetsAfterHours
	}
	if len(in.Eligibility) > 0 {
		list := make([]any, len(in.Eligibility))
		for i, p := range in.Eligibility {
			list[i] = map[string]any{
				"predicate": p.Predicate,
				"value":     p.Value,
			}
		}
		e["eligibility"] = list
	}
	return e
}

func getHolidays(doc map[string]any) []any {
	cals, ok := doc["calendars"].(map[string]any)
	if !ok {
		return []any{}
	}
	h, ok := cals["holidays"].([]any)
	if !ok {
		return []any{}
	}
	return h
}

func setHolidays(doc map[string]any, holidays []any) {
	cals, ok := doc["calendars"].(map[string]any)
	if !ok {
		cals = map[string]any{}
		doc["calendars"] = cals
	}
	cals["holidays"] = holidays
}

func getRules(doc map[string]any) []any {
	r, ok := doc["rules"].([]any)
	if !ok {
		return []any{}
	}
	return r
}

func stringMapToAny(in map[string]string) map[string]any {
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func validateHoliday(h HolidayInput) error {
	if h.ID == "" {
		return &ValidationError{Field: "id", Message: "is required"}
	}
	if len(h.ID) > 64 {
		return &ValidationError{Field: "id", Message: "must be <=64 chars"}
	}
	if !slugRe.MatchString(h.ID) {
		return &ValidationError{Field: "id", Message: "must match ^[a-z0-9_]+$"}
	}
	if h.Date == "" || !dateRe.MatchString(h.Date) {
		return &ValidationError{Field: "date", Message: "must be YYYY-MM-DD"}
	}
	if _, err := time.Parse("2006-01-02", h.Date); err != nil {
		return &ValidationError{Field: "date", Message: "invalid calendar date"}
	}
	if len(h.Name) == 0 {
		return &ValidationError{Field: "name", Message: "must include at least one locale (e.g. en or ru)"}
	}
	for lang, val := range h.Name {
		if val == "" {
			return &ValidationError{Field: "name." + lang, Message: "must be non-empty"}
		}
	}
	return nil
}

func validateRule(r RuleInput) error {
	if r.ID == "" {
		return &ValidationError{Field: "id", Message: "is required"}
	}
	if !slices.Contains(AllowedRuleIDs, r.ID) {
		return &ValidationError{Field: "id", Message: fmt.Sprintf("must be one of %v", AllowedRuleIDs)}
	}
	if !slices.Contains(AllowedModes, r.Mode) {
		return &ValidationError{Field: "mode", Message: fmt.Sprintf("must be one of %v", AllowedModes)}
	}
	if !slices.Contains(AllowedSessionStrategies, r.SessionStrategy) {
		return &ValidationError{Field: "session_strategy", Message: fmt.Sprintf("must be one of %v", AllowedSessionStrategies)}
	}
	if r.PrepWindowHours < 0 {
		return &ValidationError{Field: "prep_window_hours", Message: "must be >=0"}
	}
	if r.RefreshIfOlderThanHours < 0 {
		return &ValidationError{Field: "refresh_if_older_than_hours", Message: "must be >=0"}
	}
	if r.CooldownHours < 0 {
		return &ValidationError{Field: "cooldown_hours", Message: "must be >=0"}
	}
	if r.DismissResetsAfterHours != nil && *r.DismissResetsAfterHours < 0 {
		return &ValidationError{Field: "dismiss_resets_after_hours", Message: "must be >=0"}
	}
	for i, p := range r.Eligibility {
		if !slices.Contains(AllowedPredicates, p.Predicate) {
			return &ValidationError{Field: fmt.Sprintf("eligibility[%d].predicate", i), Message: fmt.Sprintf("must be one of %v", AllowedPredicates)}
		}
		switch p.Predicate {
		case "has_notifications_permission", "is_subscribed":
			if _, ok := p.Value.(bool); !ok {
				return &ValidationError{
					Field:   fmt.Sprintf("eligibility[%d].value", i),
					Message: "must be a bool for " + p.Predicate,
				}
			}
		default:
			switch p.Value.(type) {
			case int, int64, float64:
			default:
				return &ValidationError{
					Field:   fmt.Sprintf("eligibility[%d].value", i),
					Message: "must be a number for " + p.Predicate,
				}
			}
		}
	}
	return nil
}
