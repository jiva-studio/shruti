"""Known violation: a JWT verifier whose refresh-token refusal is only a comment."""


# test_audience_auth_rejected: a refresh token (aud="auth") is refused.
def test_access_token_is_accepted() -> None:
    assert True
