package handler

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/auth/internal/domain/profile"
)

func collectAll() profile.ProfilePolicy {
	return profile.ProfilePolicy{
		Email:     profile.FieldPolicy{Enabled: true},
		Name:      profile.FieldPolicy{Enabled: true},
		AvatarURL: profile.FieldPolicy{Enabled: true},
	}
}

func collectNone() profile.ProfilePolicy { return profile.ProfilePolicy{} }

func fullUser() profile.SourceUser {
	createdAt := time.Unix(1600000000, 0).UTC()
	tierExp := time.Unix(1700000000, 0).UTC()
	return profile.SourceUser{
		UserID:        uuid.MustParse("11111111-1111-1111-1111-111111111111"),
		CreatedAt:     createdAt,
		Tier:          "pro",
		TierExpiresAt: &tierExp,
		Email:         "alice@example.com",
		Name:          "Alice",
		PictureURL:    "https://cdn.example/alice.png",
		Identities: []profile.SourceIdentity{
			{Provider: "google", Subject: "gsub-1", Email: "alice@example.com", EmailVerified: true, CreatedAt: createdAt},
		},
	}
}

func meJSON(t *testing.T, p profile.ProfilePolicy, src profile.SourceUser) string {
	t.Helper()
	j, err := json.Marshal(meResponse(p.ProjectMe(src)))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(j)
}

// Under the collect-everything profile the keys `email`, `name` and
// `pictureUrl` are present, rendered as null when empty — clients parse
// this shape.
func TestMeJSON_OptionalKeysPresentWhenEmpty(t *testing.T) {
	s := meJSON(t, collectAll(), profile.SourceUser{UserID: uuid.New(), Tier: "free", CreatedAt: time.Now()})
	for _, key := range []string{`"email":null`, `"name":null`, `"pictureUrl":null`} {
		if !strings.Contains(s, key) {
			t.Errorf("key shape missing %q in %q", key, s)
		}
	}
}

// A profile that collects nothing still emits the keys, as null.
func TestMeJSON_SuppressedOptionalsRenderAsNull(t *testing.T) {
	s := meJSON(t, collectNone(), fullUser())
	for _, key := range []string{`"email":null`, `"name":null`, `"pictureUrl":null`} {
		if !strings.Contains(s, key) {
			t.Errorf("suppressed profile must still emit %q in %q", key, s)
		}
	}
}

func TestMeJSON_HomeRegionAbsent(t *testing.T) {
	for _, p := range []profile.ProfilePolicy{collectAll(), collectNone()} {
		if s := meJSON(t, p, fullUser()); strings.Contains(s, "homeRegion") {
			t.Errorf("homeRegion key must not appear in /auth/me, got %s", s)
		}
	}
}

// Old app builds parse identities as an array; null would crash them.
func TestMeJSON_IdentitiesIsAnArrayWhenEmpty(t *testing.T) {
	s := meJSON(t, collectAll(), profile.SourceUser{UserID: uuid.New(), Tier: "free", CreatedAt: time.Now()})
	if !strings.Contains(s, `"identities":[]`) {
		t.Errorf("empty identities must marshal as [], got %s", s)
	}
}

func TestMeJSON_FullShape(t *testing.T) {
	got := meJSON(t, collectAll(), fullUser())
	want := `{"userId":"11111111-1111-1111-1111-111111111111","anonymous":false,"createdAt":"2020-09-13T12:26:40Z",` +
		`"tier":"pro","tierExpiresAt":"2023-11-14T22:13:20Z","email":"alice@example.com","name":"Alice",` +
		`"pictureUrl":"https://cdn.example/alice.png","identities":[{"provider":"google","subject":"gsub-1",` +
		`"email":"alice@example.com","emailVerified":true,"createdAt":"2020-09-13T12:26:40Z"}]}`
	if got != want {
		t.Fatalf("me JSON\n got %s\nwant %s", got, want)
	}
}
