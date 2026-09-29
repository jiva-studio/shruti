// Package regions owns the `regions` section of the local config.json
// (see package configdoc) — the list of CDN/region endpoints the mobile app
// downloads from the published public/config.json on startup (mirrors
// modules/libs/domain/config.ts `RemoteAppConfig` and servers.ts `CdnServer`).
//
// These tools EDIT the local config only; they do not touch storage. Publishing is
// a separate step (catalog.config.publish for config-only, or catalog.publish
// for DB + everything). That keeps a server / IP change off the catalog's DB
// version ladder — no DB re-upload to move a host.
package regions

import (
	"encoding/json"
	"fmt"
	"net/url"
	"reflect"
	"regexp"
	"strings"
	"sync"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/configdoc"
)

const sectionKey = "regions"

// Region mirrors the mobile `CdnServer` shape (modules/libs/domain/servers.ts)
// — camelCase JSON tags so the block drops straight into the app's
// `RemoteAppConfig.regions` with no field mapping.
//
// The optional fields are omitted when empty, as the app treats them as
// absent: no shareTranscriptUrl or discoveryBaseUrl ⇒ derived from
// chatBaseUrl; no profileBaseUrl ⇒ profile sync off; no orchestratorBaseUrl ⇒
// direct ingest off. Extra carries every other key of the region as read, so
// a field the app gains later survives a read-modify-write here.
type Region struct {
	ID                  string                     `json:"id"`
	Name                string                     `json:"name"`
	URLTemplate         string                     `json:"urlTemplate"`
	ShareAudioURL       string                     `json:"shareAudioUrl"`
	ShareVideoURL       string                     `json:"shareVideoUrl"`
	ShareTranscriptURL  string                     `json:"shareTranscriptUrl,omitempty"`
	AuthBaseURL         string                     `json:"authBaseUrl"`
	ChatBaseURL         string                     `json:"chatBaseUrl"`
	ProfileBaseURL      string                     `json:"profileBaseUrl,omitempty"`
	OrchestratorBaseURL string                     `json:"orchestratorBaseUrl,omitempty"`
	DiscoveryBaseURL    string                     `json:"discoveryBaseUrl,omitempty"`
	Extra               map[string]json.RawMessage `json:"-"`
}

// regionFields is Region without its JSON methods, for the default encoding
// of the modelled fields.
type regionFields Region

// modelledKeys are the JSON names of Region's modelled fields.
var modelledKeys = func() map[string]bool {
	keys := map[string]bool{}
	t := reflect.TypeOf(regionFields{})
	for i := range t.NumField() {
		name, _, _ := strings.Cut(t.Field(i).Tag.Get("json"), ",")
		if name != "" && name != "-" {
			keys[name] = true
		}
	}
	return keys
}()

func (r Region) MarshalJSON() ([]byte, error) {
	modelled, err := json.Marshal(regionFields(r))
	if err != nil || len(r.Extra) == 0 {
		return modelled, err
	}
	merged := map[string]json.RawMessage{}
	if err := json.Unmarshal(modelled, &merged); err != nil {
		return nil, err
	}
	for k, v := range r.Extra {
		if !modelledKeys[k] {
			merged[k] = v
		}
	}
	return json.Marshal(merged)
}

func (r *Region) UnmarshalJSON(data []byte) error {
	var modelled regionFields
	if err := json.Unmarshal(data, &modelled); err != nil {
		return err
	}
	var all map[string]json.RawMessage
	if err := json.Unmarshal(data, &all); err != nil {
		return err
	}
	for k := range all {
		if modelledKeys[k] {
			delete(all, k)
		}
	}
	*r = Region(modelled)
	r.Extra = nil
	if len(all) > 0 {
		r.Extra = all
	}
	return nil
}

// ValidationError carries the offending field so the MCP layer can surface it
// under error.details.field (mirrors proactive.ValidationError).
type ValidationError struct {
	Field   string
	Message string
}

func (e *ValidationError) Error() string { return fmt.Sprintf("%s: %s", e.Field, e.Message) }

// NotFoundError signals an id that isn't in the regions list.
type NotFoundError struct{ Key string }

func (e *NotFoundError) Error() string { return fmt.Sprintf("region %q not found", e.Key) }

// ConflictError signals an operation refused to keep config sane — e.g.
// removing the last region (which would leave clients with nothing to probe).
type ConflictError struct{ Message string }

func (e *ConflictError) Error() string { return e.Message }

var idRe = regexp.MustCompile(`^[a-z0-9-]+$`)

// validate normalizes (trims) and validates a region, returning the cleaned
// copy on success.
func validate(r Region) (Region, error) {
	r.ID = strings.TrimSpace(r.ID)
	r.Name = strings.TrimSpace(r.Name)
	r.URLTemplate = strings.TrimSpace(r.URLTemplate)
	r.ShareAudioURL = strings.TrimSpace(r.ShareAudioURL)
	r.ShareVideoURL = strings.TrimSpace(r.ShareVideoURL)
	r.ShareTranscriptURL = strings.TrimSpace(r.ShareTranscriptURL)
	r.AuthBaseURL = strings.TrimSpace(r.AuthBaseURL)
	r.ChatBaseURL = strings.TrimSpace(r.ChatBaseURL)
	r.ProfileBaseURL = strings.TrimSpace(r.ProfileBaseURL)
	r.OrchestratorBaseURL = strings.TrimSpace(r.OrchestratorBaseURL)
	r.DiscoveryBaseURL = strings.TrimSpace(r.DiscoveryBaseURL)

	if !idRe.MatchString(r.ID) {
		return Region{}, &ValidationError{Field: "id", Message: "must be non-empty and match [a-z0-9-]+"}
	}
	if r.Name == "" {
		return Region{}, &ValidationError{Field: "name", Message: "must be non-empty"}
	}
	if !strings.Contains(r.URLTemplate, "{path}") {
		return Region{}, &ValidationError{Field: "urlTemplate", Message: "must contain the {path} placeholder"}
	}
	if err := requireHTTPS(strings.ReplaceAll(r.URLTemplate, "{path}", "x")); err != nil {
		return Region{}, &ValidationError{Field: "urlTemplate", Message: err.Error()}
	}
	for field, val := range map[string]string{
		"shareAudioUrl": r.ShareAudioURL,
		"shareVideoUrl": r.ShareVideoURL,
		"authBaseUrl":   r.AuthBaseURL,
		"chatBaseUrl":   r.ChatBaseURL,
	} {
		if err := requireHTTPS(val); err != nil {
			return Region{}, &ValidationError{Field: field, Message: err.Error()}
		}
	}
	// The optional URLs are validated only when supplied.
	for _, opt := range []struct{ field, val string }{
		{"shareTranscriptUrl", r.ShareTranscriptURL},
		{"profileBaseUrl", r.ProfileBaseURL},
		{"orchestratorBaseUrl", r.OrchestratorBaseURL},
		{"discoveryBaseUrl", r.DiscoveryBaseURL},
	} {
		if opt.val == "" {
			continue
		}
		if err := requireHTTPS(opt.val); err != nil {
			return Region{}, &ValidationError{Field: opt.field, Message: err.Error()}
		}
	}
	return r, nil
}

func requireHTTPS(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("invalid URL: %v", err)
	}
	if u.Scheme != "https" {
		return fmt.Errorf("must be an https:// URL")
	}
	if u.Host == "" {
		return fmt.Errorf("must include a host")
	}
	return nil
}

// UseCase edits the `regions` section of the local config.json.
type UseCase struct {
	OutDir string
	Mu     *sync.Mutex
}

func (uc UseCase) store() configdoc.Store {
	return configdoc.Store{OutDir: uc.OutDir, Mu: uc.Mu}
}

// readRegions loads the config doc and extracts the regions list.
func (uc UseCase) readRegions() (map[string]any, []Region, error) {
	doc, _, err := uc.store().Load()
	if err != nil {
		return nil, nil, err
	}
	if doc == nil {
		doc = map[string]any{}
	}
	list, err := extractRegions(doc)
	if err != nil {
		return nil, nil, err
	}
	return doc, list, nil
}

func extractRegions(doc map[string]any) ([]Region, error) {
	raw, ok := doc[sectionKey]
	if !ok {
		return nil, nil
	}
	b, err := json.Marshal(raw)
	if err != nil {
		return nil, err
	}
	var out []Region
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, fmt.Errorf("config.json regions is malformed: %w", err)
	}
	return out, nil
}

func (uc UseCase) writeRegions(doc map[string]any, list []Region) (string, error) {
	if list == nil {
		list = []Region{}
	}
	doc[sectionKey] = list
	return uc.store().Save(doc)
}

// List returns the regions from the local config.json.
func (uc UseCase) List() ([]Region, error) {
	_, list, err := uc.readRegions()
	if err != nil {
		return nil, err
	}
	if list == nil {
		list = []Region{}
	}
	return list, nil
}

// Get returns one region by id, or NotFoundError.
func (uc UseCase) Get(id string) (Region, error) {
	list, err := uc.List()
	if err != nil {
		return Region{}, err
	}
	for _, r := range list {
		if r.ID == id {
			return r, nil
		}
	}
	return Region{}, &NotFoundError{Key: id}
}

// optionalFields maps each optional field's JSON name to its place in Region.
var optionalFields = map[string]func(*Region) *string{
	"shareTranscriptUrl":  func(r *Region) *string { return &r.ShareTranscriptURL },
	"profileBaseUrl":      func(r *Region) *string { return &r.ProfileBaseURL },
	"orchestratorBaseUrl": func(r *Region) *string { return &r.OrchestratorBaseURL },
	"discoveryBaseUrl":    func(r *Region) *string { return &r.DiscoveryBaseURL },
}

// Upsert validates and writes the region (replace-by-id in place, else append)
// into the local config.json. Replacing merges: an optional field the input
// leaves empty keeps its current value unless it is named in clearFields, and the
// region's unmodelled keys are kept unless the input carries its own.
// Returns the region as written.
func (uc UseCase) Upsert(in Region, clearFields ...string) (Region, error) {
	for _, name := range clearFields {
		if _, ok := optionalFields[name]; !ok {
			return Region{}, &ValidationError{Field: "clear", Message: fmt.Sprintf("%q is not an optional region field", name)}
		}
	}
	clean, err := validate(in)
	if err != nil {
		return Region{}, err
	}
	for _, name := range clearFields {
		if *optionalFields[name](&clean) != "" {
			return Region{}, &ValidationError{Field: "clear", Message: fmt.Sprintf("%q is both given and named in clear", name)}
		}
	}
	uc.Mu.Lock()
	defer uc.Mu.Unlock()
	doc, list, err := uc.readRegions()
	if err != nil {
		return Region{}, err
	}
	replaced := false
	for i := range list {
		if list[i].ID == clean.ID {
			mergeOptional(&clean, list[i], clearFields)
			list[i] = clean
			replaced = true
			break
		}
	}
	if !replaced {
		list = append(list, clean)
	}
	if _, err := uc.writeRegions(doc, list); err != nil {
		return Region{}, err
	}
	return clean, nil
}

// mergeOptional fills the optional fields and unmodelled keys in leaves empty
// from current, except the fields named in clearFields.
func mergeOptional(in *Region, current Region, clearFields []string) {
	cleared := map[string]bool{}
	for _, name := range clearFields {
		cleared[name] = true
	}
	for name, field := range optionalFields {
		if cleared[name] {
			*field(in) = ""
			continue
		}
		if *field(in) == "" {
			*field(in) = *field(&current)
		}
	}
	if in.Extra == nil {
		in.Extra = current.Extra
	}
}

// Remove deletes a region by id. Refuses to remove the last remaining one
// (would leave clients nothing to probe).
func (uc UseCase) Remove(id string) (string, error) {
	uc.Mu.Lock()
	defer uc.Mu.Unlock()
	doc, list, err := uc.readRegions()
	if err != nil {
		return "", err
	}
	found := false
	for _, r := range list {
		if r.ID == id {
			found = true
			break
		}
	}
	if !found {
		return "", &NotFoundError{Key: id}
	}
	if len(list) <= 1 {
		return "", &ConflictError{Message: "cannot remove the last region — at least one must remain for clients to probe"}
	}
	filtered := make([]Region, 0, len(list))
	for _, r := range list {
		if r.ID != id {
			filtered = append(filtered, r)
		}
	}
	if _, err := uc.writeRegions(doc, filtered); err != nil {
		return "", err
	}
	return id, nil
}
