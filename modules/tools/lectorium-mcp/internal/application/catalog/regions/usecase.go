// Package regions owns the `regions` section of the local config.json
// (see package configdoc) — the list of CDN/region endpoints the mobile app
// downloads from the published public/config.json on startup (mirrors
// modules/libs/domain/config.ts `RemoteAppConfig` and servers.ts `CdnServer`).
//
// These tools EDIT the local config only; they do not touch S3. Publishing is
// a separate step (catalog.config.publish for config-only, or catalog.publish
// for DB + everything). That keeps a server / IP change off the catalog's DB
// version ladder — no DB re-upload to move a host.
package regions

import (
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"sync"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/catalog/configdoc"
)

const sectionKey = "regions"

// Region mirrors the mobile `CdnServer` shape (modules/libs/domain/servers.ts)
// one-to-one — camelCase JSON tags so the block drops straight into the app's
// `RemoteAppConfig.regions` with no field mapping.
type Region struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	URLTemplate   string `json:"urlTemplate"`
	ShareAudioURL string `json:"shareAudioUrl"`
	ShareVideoURL string `json:"shareVideoUrl"`
	AuthBaseURL   string `json:"authBaseUrl"`
	ChatBaseURL   string `json:"chatBaseUrl"`
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
	r.AuthBaseURL = strings.TrimSpace(r.AuthBaseURL)
	r.ChatBaseURL = strings.TrimSpace(r.ChatBaseURL)

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

// Upsert validates and writes the region (replace-by-id in place, else append)
// into the local config.json. Returns the cleaned region.
func (uc UseCase) Upsert(in Region) (Region, error) {
	clean, err := validate(in)
	if err != nil {
		return Region{}, err
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
