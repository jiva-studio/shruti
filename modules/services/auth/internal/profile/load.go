package profile

import (
	"fmt"
	"os"
	"sort"

	"gopkg.in/yaml.v3"
)

// configFile mirrors the top-level shape of config.yaml — only the
// `profile_collection.profiles` subtree is consumed here. Other top-
// level sections may be added later without touching this loader.
type configFile struct {
	ProfileCollection struct {
		Profiles map[string]ProfilePolicy `yaml:"profiles"`
	} `yaml:"profile_collection"`
}

// LoadPolicy reads `path` and returns the policy named `profileName`.
// Fails if the file doesn't exist, the YAML is malformed, or the
// requested profile isn't defined — the caller should treat any error
// as fatal (do not boot with an unknown profile).
func LoadPolicy(path, profileName string) (ProfilePolicy, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return ProfilePolicy{}, fmt.Errorf("read profile config %q: %w", path, err)
	}
	var f configFile
	if err := yaml.Unmarshal(data, &f); err != nil {
		return ProfilePolicy{}, fmt.Errorf("parse profile config %q: %w", path, err)
	}
	p, ok := f.ProfileCollection.Profiles[profileName]
	if !ok {
		names := make([]string, 0, len(f.ProfileCollection.Profiles))
		for k := range f.ProfileCollection.Profiles {
			names = append(names, k)
		}
		sort.Strings(names)
		return ProfilePolicy{}, fmt.Errorf("unknown profile %q (defined: %v)", profileName, names)
	}
	return p, nil
}
