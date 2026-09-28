#!/usr/bin/env bash
set -euo pipefail

# Every service that verifies the auth service's tokens must prove, in its own
# tests, that a refresh token (aud="auth") is refused where an access token
# (aud="chat") is expected. A service verifies tokens when its go.mod requires
# golang-jwt or its pyproject.toml requires PyJWT.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/modules/services"

pattern='Refresh[A-Za-z_]*Reject|Reject[A-Za-z_]*Refresh|refresh aud=auth|audience_auth_rejected'
missing=0
checked=0

for svc in */; do
	svc="${svc%/}"
	if grep -qs 'golang-jwt' "$svc/go.mod" || grep -qsi 'pyjwt' "$svc/app/pyproject.toml" "$svc/pyproject.toml"; then
		checked=$((checked + 1))
		if ! grep -rqsE "$pattern" "$svc" --include='*_test.go' --include='test_*.py'; then
			echo "✗ $svc verifies JWTs but has no test refusing a refresh token (aud=\"auth\")"
			missing=$((missing + 1))
		fi
	fi
done

if [ "$missing" -gt 0 ]; then
	exit 1
fi
echo "jwt audience tests: $checked verifier services, each refuses aud=\"auth\""
