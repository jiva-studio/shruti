package config

import (
	"fmt"
	"os"
	"sort"

	"gopkg.in/yaml.v3"

	"github.com/jiva-studio/shruti/auth/internal/domain/profile"
)

// configFile mirrors the top-level shape of config.yaml; only the
// `profile_collection.profiles` subtree is read.
type configFile struct {
	ProfileCollection struct {
		Profiles map[string]policyFile `yaml:"profiles"`
	} `yaml:"profile_collection"`
}

type policyFile struct {
	Email     fieldFile `yaml:"email"`
	Name      fieldFile `yaml:"name"`
	AvatarURL fieldFile `yaml:"avatar_url"`
}

type fieldFile struct {
	Enabled bool   `yaml:"enabled"`
	Purpose string `yaml:"purpose"`
}

// LoadPolicy reads `path` and returns the profile-collection policy named
// `profileName`. Fails if the file doesn't exist, the YAML is malformed, or
// the requested profile isn't defined — the caller treats any error as fatal
// (the service does not boot with an unknown profile).
func LoadPolicy(path, profileName string) (profile.ProfilePolicy, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return profile.ProfilePolicy{}, fmt.Errorf("read profile config %q: %w", path, err)
	}
	var f configFile
	if err := yaml.Unmarshal(data, &f); err != nil {
		return profile.ProfilePolicy{}, fmt.Errorf("parse profile config %q: %w", path, err)
	}
	p, ok := f.ProfileCollection.Profiles[profileName]
	if !ok {
		names := make([]string, 0, len(f.ProfileCollection.Profiles))
		for k := range f.ProfileCollection.Profiles {
			names = append(names, k)
		}
		sort.Strings(names)
		return profile.ProfilePolicy{}, fmt.Errorf("unknown profile %q (defined: %v)", profileName, names)
	}
	return profile.ProfilePolicy{
		Email:     profile.FieldPolicy(p.Email),
		Name:      profile.FieldPolicy(p.Name),
		AvatarURL: profile.FieldPolicy(p.AvatarURL),
	}, nil
}
