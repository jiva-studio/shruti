// Package account holds the identity model of the auth service: a user, the
// provider identities that sign in as that user, and the refresh tokens that
// keep a device signed in.
package account

import (
	"errors"
	"time"

	"github.com/google/uuid"
)

// Identity providers. The strings are stored in auth.identities and are
// immutable.
const (
	ProviderGoogle = "google"
	ProviderApple  = "apple"
	ProviderDevice = "device"
	ProviderEmail  = "email"
)

// User is one auth.users row. Tier, TierExpiresAt and TierUpdatedAt mirror
// the RevenueCat subscription; RCAppUserID binds the user to a RevenueCat
// customer.
type User struct {
	ID            uuid.UUID
	Name          *string
	PictureURL    *string
	CreatedAt     time.Time
	Tier          string
	TierExpiresAt *time.Time
	TierUpdatedAt *time.Time
	RCAppUserID   *string
}

// Identity is one (provider, subject) that signs in as a user. The stored
// email_verified is nullable; an absent value reads as false.
type Identity struct {
	Provider      string
	Subject       string
	UserID        uuid.UUID
	Email         *string
	EmailVerified bool
	CreatedAt     time.Time
}

// ErrIdentityExists reports that (provider, subject) is already taken — a
// concurrent sign-in of the same identity committed first.
var ErrIdentityExists = errors.New("identity already exists")

// RefreshToken is one issued refresh token. ReplacedBy is the successor's jti
// once the token was rotated; it stays nil for a live token and for one
// revoked by signout.
type RefreshToken struct {
	JTI        uuid.UUID
	UserID     uuid.UUID
	DeviceID   *string
	ExpiresAt  time.Time
	RevokedAt  *time.Time
	ReplacedBy *uuid.UUID
}

// ProviderIdentity is what a verified third-party id token says about its
// holder. Nonce is the token's `nonce` claim, "" when absent.
type ProviderIdentity struct {
	Subject       string
	Email         string
	EmailVerified bool
	Name          string
	PictureURL    string
	Nonce         string
}

// IsAnonymous reports whether a user with these identities is anonymous: one
// who has no identity but a device.
func IsAnonymous(identities []Identity) bool {
	for _, i := range identities {
		if i.Provider != ProviderDevice {
			return false
		}
	}
	return true
}
