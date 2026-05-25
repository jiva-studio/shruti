"""Coverage for the kid-aware JwtVerifier.

Sign tokens with PyJWT against freshly generated RSA keys and confirm
the verifier picks the right key based on the token's `kid` header,
including the legacy single-file path and the directory-with-rotation
path.
"""

from __future__ import annotations

from pathlib import Path

import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from lectorium_chat.infra.auth.jwt_verifier import (
    JwtVerifier,
    JwtVerifyError,
)


def _keypair() -> tuple[str, str]:
    """Return (private_pem, public_pem) text for a fresh RSA-2048 key."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    priv = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    pub = key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    return priv, pub


def _sign(
    priv: str,
    kid: str,
    sub: str = "user-1",
    anonymous: bool = False,
    quota_id: str | None = None,
) -> str:
    claims: dict[str, object] = {"sub": sub, "anonymous": anonymous, "exp": 9999999999}
    if quota_id is not None:
        claims["quota_id"] = quota_id
    return pyjwt.encode(
        claims,
        priv,
        algorithm="RS256",
        headers={"kid": kid},
    )


def test_from_file_accepts_v1_token(tmp_path: Path) -> None:
    priv, pub = _keypair()
    (tmp_path / "public.pem").write_text(pub)

    v = JwtVerifier.from_file(tmp_path / "public.pem")
    user = v.verify(_sign(priv, "v1"))
    assert user.id == "user-1"
    assert user.anonymous is False


def test_from_dir_accepts_both_kids_during_rotation(tmp_path: Path) -> None:
    priv1, pub1 = _keypair()
    priv2, pub2 = _keypair()
    (tmp_path / "v1.pub.pem").write_text(pub1)
    (tmp_path / "v2.pub.pem").write_text(pub2)

    v = JwtVerifier.from_dir(tmp_path)
    assert v.verify(_sign(priv1, "v1")).id == "user-1"
    assert v.verify(_sign(priv2, "v2")).id == "user-1"


def test_from_dir_maps_legacy_public_pem_to_v1(tmp_path: Path) -> None:
    priv, pub = _keypair()
    (tmp_path / "public.pem").write_text(pub)

    v = JwtVerifier.from_dir(tmp_path)
    assert v.verify(_sign(priv, "v1")).id == "user-1"


def test_unknown_kid_rejected(tmp_path: Path) -> None:
    priv, pub = _keypair()
    (tmp_path / "v1.pub.pem").write_text(pub)

    v = JwtVerifier.from_dir(tmp_path)
    with pytest.raises(JwtVerifyError, match="unknown kid"):
        v.verify(_sign(priv, "v999"))


def test_foreign_key_signature_rejected(tmp_path: Path) -> None:
    # v1 mapping holds pubkey A; token is signed by an unrelated B
    # but stamped with kid="v1". Must reject.
    _, pubA = _keypair()
    privB, _ = _keypair()
    (tmp_path / "public.pem").write_text(pubA)

    v = JwtVerifier.from_dir(tmp_path)
    with pytest.raises(JwtVerifyError):
        v.verify(_sign(privB, "v1"))


# ── quota_id format validation ───────────────────────────────────────────


def _verifier(tmp_path: Path) -> tuple[JwtVerifier, str]:
    priv, pub = _keypair()
    (tmp_path / "public.pem").write_text(pub)
    return JwtVerifier.from_file(tmp_path / "public.pem"), priv


def test_quota_id_valid_hex_passes_through(tmp_path: Path) -> None:
    v, priv = _verifier(tmp_path)
    qid = "a" * 64
    user = v.verify(_sign(priv, "v1", quota_id=qid))
    assert user.quota_id == qid


def test_quota_id_mixed_hex_digits_passes_through(tmp_path: Path) -> None:
    v, priv = _verifier(tmp_path)
    # Plausible sha256 hex: lower-case [0-9a-f], exactly 64 chars.
    qid = "0123456789abcdef" * 4
    user = v.verify(_sign(priv, "v1", quota_id=qid))
    assert user.quota_id == qid


def test_quota_id_empty_string_passes_through(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    v, priv = _verifier(tmp_path)
    user = v.verify(_sign(priv, "v1", quota_id=""))
    assert user.quota_id == ""
    # Empty is the documented "no OAuth identity" case — must NOT warn.
    out = capsys.readouterr()
    assert "quota_id_invalid_format" not in (out.out + out.err)


def test_quota_id_missing_claim_passes_through(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    # Pre-Phase-3 tokens lack the claim entirely — same shape as empty.
    v, priv = _verifier(tmp_path)
    user = v.verify(_sign(priv, "v1", quota_id=None))
    assert user.quota_id == ""
    out = capsys.readouterr()
    assert "quota_id_invalid_format" not in (out.out + out.err)


@pytest.mark.parametrize(
    "bad_qid",
    [
        "abc",                  # too short
        "X" * 64,                # right length, non-hex
        "A" * 64,                # right length, upper-case hex (we accept only lower)
        "g" * 64,                # right length, 'g' is not a hex digit
        "0" * 63 + "G",          # 64 chars but contains uppercase non-hex
        "0" * 65,                # too long
        " " + "a" * 63,          # leading whitespace
        "a" * 63 + " ",          # trailing whitespace
    ],
)
def test_quota_id_invalid_falls_back_to_empty_and_warns(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], bad_qid: str
) -> None:
    v, priv = _verifier(tmp_path)
    user = v.verify(_sign(priv, "v1", quota_id=bad_qid))
    assert user.quota_id == ""
    # structlog (default config) renders to stdout/stderr via PrintLogger,
    # so capsys is the right fixture here. The marker is the event name
    # in the rendered line.
    out = capsys.readouterr()
    assert "quota_id_invalid_format" in (out.out + out.err)


# ── tier_expires_at parsing (plan 1.7) ───────────────────────────────────


def test_tier_expires_at_parsed(tmp_path: Path) -> None:
    priv, pub = _keypair()
    (tmp_path / "public.pem").write_text(pub)
    v = JwtVerifier.from_file(tmp_path / "public.pem")
    tok = pyjwt.encode(
        {
            "sub": "user-1",
            "anonymous": False,
            "tier": "pro",
            "tier_expires_at": 1700000000,
            "exp": 9999999999,
        },
        priv,
        algorithm="RS256",
        headers={"kid": "v1"},
    )
    user = v.verify(tok)
    assert user.tier == "pro"
    assert user.tier_expires_at == 1700000000


def test_tier_expires_at_missing_defaults_to_zero(tmp_path: Path) -> None:
    # Old in-flight tokens that pre-date 1.7 lack the claim entirely.
    # Verifier must default to 0 (lifetime / no-expiry) so existing
    # Pro users don't get falsely downgraded mid-rollout.
    priv, pub = _keypair()
    (tmp_path / "public.pem").write_text(pub)
    v = JwtVerifier.from_file(tmp_path / "public.pem")
    user = v.verify(_sign(priv, "v1"))
    assert user.tier_expires_at == 0
