package profile

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func globalProfile() ProfilePolicy {
	return ProfilePolicy{
		Email:     FieldPolicy{Enabled: true},
		Name:      FieldPolicy{Enabled: true},
		AvatarURL: FieldPolicy{Enabled: true},
	}
}

func ruProfile() ProfilePolicy {
	return ProfilePolicy{
		Email:     FieldPolicy{Enabled: false},
		Name:      FieldPolicy{Enabled: false},
		AvatarURL: FieldPolicy{Enabled: false},
	}
}

func fullSource() SourceUser {
	tierExp := time.Unix(1700000000, 0).UTC()
	createdAt := time.Unix(1600000000, 0).UTC()
	return SourceUser{
		UserID:        uuid.MustParse("11111111-1111-1111-1111-111111111111"),
		Anonymous:     false,
		CreatedAt:     createdAt,
		Tier:          "pro",
		TierExpiresAt: &tierExp,
		Email:         "alice@example.com",
		Name:          "Alice",
		PictureURL:    "https://cdn.example/alice.png",
		HomeRegion:    "global",
		Identities: []SourceIdentity{
			{
				Provider:      "google",
				Subject:       "gsub-1",
				Email:         "alice@example.com",
				EmailVerified: true,
				CreatedAt:     createdAt,
			},
			{
				Provider:      "device",
				Subject:       "dev-xyz",
				EmailVerified: false,
				CreatedAt:     createdAt,
			},
		},
	}
}

func TestProjectMe_GlobalProfileRetainsAllFields(t *testing.T) {
	p := globalProfile()
	src := fullSource()
	out := p.ProjectMe(src)

	if out.UserID != src.UserID {
		t.Errorf("UserID lost: %v != %v", out.UserID, src.UserID)
	}
	if out.Email == nil || *out.Email != "alice@example.com" {
		t.Errorf("email dropped: %+v", out.Email)
	}
	if out.Name == nil || *out.Name != "Alice" {
		t.Errorf("name dropped: %+v", out.Name)
	}
	if out.PictureURL == nil || *out.PictureURL != "https://cdn.example/alice.png" {
		t.Errorf("picture dropped: %+v", out.PictureURL)
	}
	if out.Tier != "pro" {
		t.Errorf("tier lost: %q", out.Tier)
	}
	if out.TierExpiresAt == nil {
		t.Errorf("tierExpiresAt dropped")
	}
	if len(out.Identities) != 2 {
		t.Fatalf("identities lost, got %d", len(out.Identities))
	}
	if out.Identities[0].Email == nil || *out.Identities[0].Email != "alice@example.com" {
		t.Errorf("identity email dropped: %+v", out.Identities[0])
	}
	if !out.Identities[0].EmailVerified {
		t.Errorf("identity emailVerified dropped")
	}
	if out.HomeRegion != "global" {
		t.Errorf("homeRegion dropped: %q", out.HomeRegion)
	}
}

func TestProjectMe_RuProfileOmitsOptionals(t *testing.T) {
	p := ruProfile()
	src := fullSource()

	out := p.ProjectMe(src)

	if out.Email != nil {
		t.Errorf("email must be nil under ru profile, got %q", *out.Email)
	}
	if out.Name != nil {
		t.Errorf("name must be nil under ru profile, got %q", *out.Name)
	}
	if out.PictureURL != nil {
		t.Errorf("pictureUrl must be nil under ru profile, got %q", *out.PictureURL)
	}
	// Tier always emitted.
	if out.Tier != "pro" {
		t.Errorf("tier lost: %q", out.Tier)
	}
	// Identities: provider+subject must survive so migrate-in can mirror
	// them; per-identity email must be stripped.
	if len(out.Identities) != 2 {
		t.Fatalf("identities count: %d", len(out.Identities))
	}
	for i, id := range out.Identities {
		if id.Provider == "" || id.Subject == "" {
			t.Errorf("identity[%d] missing provider/subject: %+v", i, id)
		}
		if id.Email != nil {
			t.Errorf("identity[%d] email should be nil under ru, got %q", i, *id.Email)
		}
		if id.EmailVerified {
			t.Errorf("identity[%d] emailVerified should be false under ru", i)
		}
	}
}

func TestProjectMe_DisabledFieldOverridesDBValue(t *testing.T) {
	// Even if the DB row has a value, a disabled policy must omit it.
	p := ProfilePolicy{
		Email: FieldPolicy{Enabled: false},
		Name:  FieldPolicy{Enabled: false},
	}
	src := SourceUser{
		UserID:     uuid.New(),
		Tier:       "free",
		CreatedAt:  time.Now(),
		Email:      "leak@example.com",
		Name:       "Leak",
		PictureURL: "https://leak.example",
	}
	out := p.ProjectMe(src)
	if out.Email != nil {
		t.Errorf("email leaked despite disabled policy: %q", *out.Email)
	}
	if out.Name != nil {
		t.Errorf("name leaked despite disabled policy: %q", *out.Name)
	}
	if out.PictureURL != nil {
		t.Errorf("picture leaked despite disabled AvatarURL policy: %q", *out.PictureURL)
	}
}

func TestProjectMe_EnabledButEmptyValueStaysNil(t *testing.T) {
	// Policy says collect, but DB row has nothing → field rendered as
	// null (pointer stays nil). Distinct from "policy disabled" only at
	// the semantic level — wire shape is the same.
	p := globalProfile()
	src := SourceUser{
		UserID:    uuid.New(),
		Tier:      "free",
		CreatedAt: time.Now(),
	}
	out := p.ProjectMe(src)
	if out.Email != nil {
		t.Errorf("empty source email must produce nil pointer, got %q", *out.Email)
	}
	if out.Name != nil {
		t.Errorf("empty source name must produce nil pointer")
	}
	if out.PictureURL != nil {
		t.Errorf("empty source pictureUrl must produce nil pointer")
	}
}

func TestProjectMe_GlobalJsonShape_PreservesLegacyKeys(t *testing.T) {
	// Byte-shape invariant: under global profile the JSON keys
	// `email`, `name`, `pictureUrl` are PRESENT (rendered as null when
	// nil) — clients have parsed this shape since before policy. Only
	// `locale` is allowed to be absent (omitempty) since it never
	// existed pre-policy.
	p := globalProfile()
	src := SourceUser{
		UserID:    uuid.New(),
		Tier:      "free",
		CreatedAt: time.Now(),
	}
	out := p.ProjectMe(src)
	j, err := json.Marshal(out)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	s := string(j)
	for _, key := range []string{`"email":null`, `"name":null`, `"pictureUrl":null`} {
		if !strings.Contains(s, key) {
			t.Errorf("legacy key shape missing %q in %q", key, s)
		}
	}
}

func TestProjectMe_RuJsonShape_OptionalsRenderAsNull(t *testing.T) {
	// RU profile: email/name/pictureUrl keys are present-but-null
	// (same wire shape as legacy global with empty values). Mobile's
	// `name || email || signedIn` cascade lands on signedIn, no parse
	// error.
	p := ruProfile()
	src := fullSource()
	out := p.ProjectMe(src)
	j, err := json.Marshal(out)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	s := string(j)
	for _, key := range []string{`"email":null`, `"name":null`, `"pictureUrl":null`} {
		if !strings.Contains(s, key) {
			t.Errorf("ru profile must still emit %q (just as null) in %q", key, s)
		}
	}
}

func TestProjectMe_HomeRegionPassesThroughUnderEveryPolicy(t *testing.T) {
	// HomeRegion is server-authoritative metadata: mobile uses it to
	// reconcile its local activeServer choice with reality. It must
	// ride through both the global and ru policies unchanged.
	cases := []struct {
		name   string
		policy ProfilePolicy
		region string
	}{
		{"global-policy/global", globalProfile(), "global"},
		{"global-policy/russia", globalProfile(), "russia"},
		{"ru-policy/russia", ruProfile(), "russia"},
		{"ru-policy/global", ruProfile(), "global"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			src := fullSource()
			src.HomeRegion = tc.region
			out := tc.policy.ProjectMe(src)
			if out.HomeRegion != tc.region {
				t.Errorf("homeRegion=%q, want %q", out.HomeRegion, tc.region)
			}
			j, err := json.Marshal(out)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			want := `"homeRegion":"` + tc.region + `"`
			if !strings.Contains(string(j), want) {
				t.Errorf("expected %s in %s", want, string(j))
			}
		})
	}
}

func TestProjectMe_IdentitiesNonNilEvenWhenEmpty(t *testing.T) {
	// Mobile parses identities as an array; null would crash older
	// builds. The slice must always render as `[]`.
	p := globalProfile()
	src := SourceUser{UserID: uuid.New(), Tier: "free", CreatedAt: time.Now()}
	out := p.ProjectMe(src)
	if out.Identities == nil {
		t.Fatalf("Identities must be a non-nil empty slice")
	}
	j, _ := json.Marshal(out)
	if !strings.Contains(string(j), `"identities":[]`) {
		t.Errorf("empty identities must marshal as [], got %s", string(j))
	}
}
