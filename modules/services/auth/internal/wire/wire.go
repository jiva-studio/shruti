// Package wire holds the request and response bodies of the auth service's
// HTTP API. Installed apps parse these shapes; a key is never renamed or
// dropped.
package wire

import (
	"time"

	"github.com/google/uuid"
)

// AnonymousRequest is POST /auth/anonymous.
type AnonymousRequest struct {
	DeviceID string `json:"deviceId"`
	Platform string `json:"platform"`
}

// SocialSigninRequest is POST /auth/signin/{google,apple}.
type SocialSigninRequest struct {
	IDToken  string `json:"idToken"`
	FullName string `json:"fullName,omitempty"`
	DeviceID string `json:"deviceId,omitempty"`
	Nonce    string `json:"nonce,omitempty"`
}

// EmailCodeRequest is POST /auth/signin/email/request. Locale selects the
// email's language (e.g. "ru", "sr-Latn"); unknown or empty means English.
type EmailCodeRequest struct {
	Email  string `json:"email"`
	Locale string `json:"locale,omitempty"`
}

// EmailCodeVerifyRequest is POST /auth/signin/email/verify.
type EmailCodeVerifyRequest struct {
	Email    string `json:"email"`
	Code     string `json:"code"`
	DeviceID string `json:"deviceId,omitempty"`
}

// RefreshRequest is POST /auth/refresh and POST /auth/signout.
type RefreshRequest struct {
	RefreshToken string `json:"refreshToken"`
}

// Session answers every sign-in and refresh.
type Session struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	UserID       string `json:"userId"`
	Anonymous    bool   `json:"anonymous"`
}

// Me is GET /auth/me. The optional profile fields carry no omitempty: their
// keys are always present, null when the deployment does not collect the
// field or the user has no value, which is the shape every client parses.
// Identities is always an array, never null.
type Me struct {
	UserID    uuid.UUID `json:"userId"`
	Anonymous bool      `json:"anonymous"`
	CreatedAt time.Time `json:"createdAt"`

	Tier          string     `json:"tier"`
	TierExpiresAt *time.Time `json:"tierExpiresAt,omitempty"`

	Email      *string `json:"email"`
	Name       *string `json:"name"`
	PictureURL *string `json:"pictureUrl"`

	Identities []MeIdentity `json:"identities"`
}

// MeIdentity is one identity inside Me.
type MeIdentity struct {
	Provider      string    `json:"provider"`
	Subject       string    `json:"subject"`
	Email         *string   `json:"email"`
	EmailVerified bool      `json:"emailVerified"`
	CreatedAt     time.Time `json:"createdAt"`
}

// Empty is the `{}` body of a success with nothing to say.
type Empty struct{}

// Error is every error body: {"error":{"code","message"}}.
type Error struct {
	Error ErrorDetail `json:"error"`
}

// ErrorDetail is the inside of Error.
type ErrorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Health is GET /auth/healthz.
type Health struct {
	Build  Build  `json:"build"`
	Status string `json:"status"`
}

// Build names the image a deployment runs.
type Build struct {
	SHA  string `json:"sha"`
	Time string `json:"time"`
}

// GrantRequest is POST /internal/subscription/grant. GrantKey (the billing
// order id) makes the grant idempotent across re-drives; empty is allowed.
type GrantRequest struct {
	UserID   string `json:"userId"`
	Duration string `json:"duration"`
	GrantKey string `json:"grantKey"`
}

// Ack answers the internal grant and the RevenueCat webhook; only the flags
// that apply are present.
type Ack struct {
	Deferred  bool `json:"deferred,omitempty"`
	Duplicate bool `json:"duplicate,omitempty"`
	OK        bool `json:"ok"`
	Permanent bool `json:"permanent,omitempty"`
	Skipped   bool `json:"skipped,omitempty"`
}

// RevenueCatWebhook is the part of a RevenueCat webhook the service reads;
// the subscriber's state always comes from a refetch. TRANSFER events carry
// no app_user_id: the entitlement moves from TransferredFrom to
// TransferredTo.
type RevenueCatWebhook struct {
	Event struct {
		ID              string   `json:"id"`
		Type            string   `json:"type"`
		AppUserID       string   `json:"app_user_id"`
		Environment     string   `json:"environment"`
		TransferredFrom []string `json:"transferred_from"`
		TransferredTo   []string `json:"transferred_to"`
	} `json:"event"`
}
