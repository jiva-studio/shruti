package sqlitecatalog

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// markModifiedMu serializes markModified's read-modify-write of catalog
// meta.json across concurrent SaveTrack callers in the same process.
// Without it, a goroutine reading mid-WriteFile sees a truncated file
// and Unmarshal fails with "unexpected end of JSON input".
var markModifiedMu sync.Mutex

// markModified flips meta.json's "modified" flag to true. Called from Lazy
// after every successful write so catalog_refresh / catalog_publish know
// there are unsaved changes.
//
// dbPath is the path to current.db; meta.json sits next to it. The write
// is atomic (tmp + rename) so even if the mutex were removed, concurrent
// readers never observe a partial file.
func markModified(dbPath string) error {
	markModifiedMu.Lock()
	defer markModifiedMu.Unlock()

	metaPath := filepath.Join(filepath.Dir(dbPath), "meta.json")
	raw, err := os.ReadFile(metaPath)
	if err != nil {
		// no meta.json yet — first write before refresh; safe to skip.
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var data map[string]any
	if err := json.Unmarshal(raw, &data); err != nil {
		return err
	}
	if v, ok := data["modified"].(bool); ok && v {
		// already marked — no need to rewrite.
		return nil
	}
	data["modified"] = true
	out, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	// Atomic write: write to temp file then rename over the original.
	tmp := metaPath + ".tmp"
	if err := os.WriteFile(tmp, out, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, metaPath)
}
