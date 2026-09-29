package google

import (
	"testing"

	"google.golang.org/api/idtoken"
)

func TestIdentityFromPayloadMapsClaims(t *testing.T) {
	v := NewVerifier([]string{"web", "ios"})
	id, err := v.identityFromPayload(&idtoken.Payload{
		Audience: "ios",
		Subject:  "g-1",
		Claims: map[string]any{
			"email":          "a@example.com",
			"name":           "A",
			"picture":        "https://example.com/a.png",
			"nonce":          "raw-nonce",
			"email_verified": true,
		},
	})
	if err != nil {
		t.Fatalf("identity: %v", err)
	}
	if id.Subject != "g-1" || id.Email != "a@example.com" || id.Name != "A" ||
		id.PictureURL != "https://example.com/a.png" || id.Nonce != "raw-nonce" || !id.EmailVerified {
		t.Fatalf("identity = %+v", id)
	}
}

func TestIdentityFromPayloadWithoutOptionalClaims(t *testing.T) {
	v := NewVerifier([]string{"web"})
	id, err := v.identityFromPayload(&idtoken.Payload{
		Audience: "web",
		Subject:  "g-2",
		Claims:   map[string]any{"email_verified": "true"},
	})
	if err != nil {
		t.Fatalf("identity: %v", err)
	}
	if id.Nonce != "" || id.Email != "" || !id.EmailVerified {
		t.Fatalf("identity = %+v", id)
	}
}

func TestIdentityFromPayloadRefusesForeignAudienceAndMissingSubject(t *testing.T) {
	v := NewVerifier([]string{"web"})
	if _, err := v.identityFromPayload(&idtoken.Payload{Audience: "other", Subject: "g"}); err == nil {
		t.Fatal("foreign audience accepted")
	}
	if _, err := v.identityFromPayload(&idtoken.Payload{Audience: "web"}); err == nil {
		t.Fatal("missing subject accepted")
	}
}
