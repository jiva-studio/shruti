package mirror

import "testing"

func TestCompareListed(t *testing.T) {
	src := Object{Key: "k", Size: 10, SHA256: "a"}
	cases := []struct {
		name   string
		dst    Held
		verify bool
		want   Verdict
	}{
		{"absent ships", Held{}, false, Transfer},
		{"absent ships even when verifying", Held{}, true, Transfer},
		{"size differs ships", Held{Listed: true, Size: 11}, false, Transfer},
		{"size differs ships without inspecting", Held{Listed: true, Size: 9}, true, Transfer},
		{"same size, unknown checksum, skips", Held{Listed: true, Size: 10}, false, Skip},
		{"same size inspected when verifying", Held{Listed: true, Size: 10}, true, Inspect},
		{"same size, known different checksum, ships", Held{Listed: true, Size: 10, SHA256: "b"}, false, Transfer},
		{"known different checksum ships without inspecting", Held{Listed: true, Size: 10, SHA256: "b"}, true, Transfer},
		{"same size, known same checksum, skips", Held{Listed: true, Size: 10, SHA256: "a"}, false, Skip},
		{"known same checksum still inspected when verifying", Held{Listed: true, Size: 10, SHA256: "a"}, true, Inspect},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := CompareListed(src, tc.dst, tc.verify); got != tc.want {
				t.Fatalf("CompareListed = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestScopeMatchesPrefixesAndPatterns(t *testing.T) {
	s, err := NewScope([]string{"private/", " "}, []string{"public/config.json", "public/tracks/*/transcripts/*.json"})
	if err != nil {
		t.Fatalf("NewScope: %v", err)
	}
	for key, want := range map[string]bool{
		"private/a":        true,
		"privateer/a":      false,
		"public/private/a": false,
	} {
		if got := s.IsExcluded(key); got != want {
			t.Errorf("IsExcluded(%q) = %v, want %v", key, got, want)
		}
	}
	for key, want := range map[string]bool{
		"public/config.json":                   true,
		"public/config.json.bak":               false,
		"public/tracks/h1/transcripts/en.json": true,
		"public/tracks/h1/audio/original.mp3":  false,
	} {
		if got := s.IsMutable(key); got != want {
			t.Errorf("IsMutable(%q) = %v, want %v", key, got, want)
		}
	}
}

func TestEmptyScopeMatchesNothing(t *testing.T) {
	var s Scope
	if s.IsExcluded("private/a") || s.IsMutable("public/config.json") {
		t.Fatal("the zero Scope must exclude nothing and treat nothing as mutable")
	}
}

func TestNewScopeRefusesLeadingSlash(t *testing.T) {
	if _, err := NewScope([]string{"/private/"}, nil); err == nil {
		t.Fatal("an exclude prefix with a leading slash matches no key and must be refused")
	}
	if _, err := NewScope(nil, []string{"/public/config.json"}); err == nil {
		t.Fatal("a mutable pattern with a leading slash matches no key and must be refused")
	}
}

func TestNewScopeRefusesMalformedPattern(t *testing.T) {
	if _, err := NewScope(nil, []string{"public/[x"}); err == nil {
		t.Fatal("malformed pattern accepted")
	}
}
