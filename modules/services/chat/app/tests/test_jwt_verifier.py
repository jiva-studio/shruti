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

from shruti_chat.infra.auth.jwt_verifier import (
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


def _sign(priv: str, kid: str, sub: str = "user-1", anonymous: bool = False) -> str:
    return pyjwt.encode(
        {"sub": sub, "anonymous": anonymous, "exp": 9999999999},
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
