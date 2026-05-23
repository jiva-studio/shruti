// Package providers and its subpackages verify third-party OIDC id-tokens
// (Google, Apple) and extract the stable subject + email.
package providers

// Identity is the normalized result of verifying a third-party id-token.
type Identity struct {
	Subject       string // Provider's stable user ID (sub claim).
	Email         string // Optional; "" if absent.
	EmailVerified bool
}
