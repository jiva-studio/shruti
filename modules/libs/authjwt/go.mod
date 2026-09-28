// Module github.com/jiva-studio/shruti/authjwt signs and verifies the auth
// service's RS256 tokens. Every service that accepts a user's bearer token
// imports it through a `replace` directive, so there is one verifier and one
// definition of what an access token is.
module github.com/jiva-studio/shruti/authjwt

go 1.25.0

require (
	github.com/golang-jwt/jwt/v5 v5.3.1
	github.com/google/uuid v1.6.0
)
