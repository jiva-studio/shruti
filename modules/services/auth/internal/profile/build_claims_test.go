package profile

import (
	"testing"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/auth/internal/jwt"
)

func sampleIdents() []jwt.ClaimIdentity {
	return []jwt.ClaimIdentity{
		{Provider: "google", Subject: "gsub-1", EmailHash: "ehash-g", EmailVerified: true},
		{Provider: "apple", Subject: "asub-1", EmailHash: "ehash-a", EmailVerified: false},
		{Provider: "device", Subject: "dev-1"},
	}
}

func TestBuildClaims_EmailEnabled_PassesThrough(t *testing.T) {
	p := ProfilePolicy{Email: FieldPolicy{Enabled: true}}
	uid := uuid.New()
	in := p.BuildClaims(uid, false, "pro", 1700000000, "qid-1", "rc-1", sampleIdents())

	if in.UserID != uid {
		t.Errorf("UserID: got %v want %v", in.UserID, uid)
	}
	if in.Tier != "pro" || in.QuotaID != "qid-1" || in.RCAppUserID != "rc-1" {
		t.Errorf("mandatory fields stripped: %+v", in)
	}
	if in.TierExpiresAt != 1700000000 {
		t.Errorf("TierExpiresAt: %d", in.TierExpiresAt)
	}
	if len(in.Identities) != 3 {
		t.Fatalf("identities len: %d", len(in.Identities))
	}
	if in.Identities[0].EmailHash != "ehash-g" || !in.Identities[0].EmailVerified {
		t.Errorf("Email policy=on must keep EmailHash/EmailVerified, got %+v", in.Identities[0])
	}
}

func TestBuildClaims_EmailDisabled_StripsEmailHash(t *testing.T) {
	// Russia profile: email collection disabled. Identity rows must
	// still ship provider+subject (the chat-side claim shape depends
	// on them) but the identifying email hash is suppressed.
	p := ProfilePolicy{Email: FieldPolicy{Enabled: false}}
	in := p.BuildClaims(uuid.New(), false, "free", 0, "qid-2", "rc-2", sampleIdents())

	if len(in.Identities) != 3 {
		t.Fatalf("identities len: %d (must keep provider/subject)", len(in.Identities))
	}
	for i, id := range in.Identities {
		if id.Provider == "" || id.Subject == "" {
			t.Errorf("identity[%d] missing provider/subject: %+v", i, id)
		}
		if id.EmailHash != "" {
			t.Errorf("identity[%d] EmailHash should be empty: %q", i, id.EmailHash)
		}
		if id.EmailVerified {
			t.Errorf("identity[%d] EmailVerified should be false: %+v", i, id)
		}
	}
}

func TestBuildClaims_EmailDisabled_MandatoryFieldsKept(t *testing.T) {
	// The policy ONLY governs EmailHash/EmailVerified. Tier, QuotaID,
	// RCAppUserID, TierExpiresAt all ship regardless — the chat
	// service reads them even when email is suppressed.
	p := ProfilePolicy{Email: FieldPolicy{Enabled: false}}
	in := p.BuildClaims(uuid.New(), true, "pro", 1234567890, "qid-3", "rc-3", nil)

	if in.Anonymous != true {
		t.Error("Anonymous must pass through")
	}
	if in.Tier != "pro" {
		t.Errorf("Tier: %q", in.Tier)
	}
	if in.QuotaID != "qid-3" {
		t.Errorf("QuotaID: %q", in.QuotaID)
	}
	if in.RCAppUserID != "rc-3" {
		t.Errorf("RCAppUserID: %q", in.RCAppUserID)
	}
	if in.TierExpiresAt != 1234567890 {
		t.Errorf("TierExpiresAt: %d", in.TierExpiresAt)
	}
}

func TestBuildClaims_EmptyIdentities(t *testing.T) {
	// Pre-signin / transient state: no identities yet. BuildClaims
	// must produce an empty-but-not-nil slice so the consumer
	// (Signer.Issue) doesn't omit the claim and the chat verifier
	// sees a stable shape.
	p := ProfilePolicy{}
	in := p.BuildClaims(uuid.New(), true, "free", 0, "", "", nil)
	if in.Identities == nil {
		t.Error("Identities should be non-nil (empty slice)")
	}
	if len(in.Identities) != 0 {
		t.Errorf("expected empty Identities, got %d", len(in.Identities))
	}
}
