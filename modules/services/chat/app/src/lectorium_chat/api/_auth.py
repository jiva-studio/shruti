"""FastAPI Bearer-token dependency.

Endpoints that depend on `get_current_user` reject any request that
doesn't carry a valid Authorization: Bearer <jwt>. Returns the
VerifiedUser dataclass so handlers don't see raw claims.
"""

from __future__ import annotations

from fastapi import Depends, Header, HTTPException

from lectorium_chat.composition import AppDeps, get_deps
from lectorium_chat.infra.auth.jwt_verifier import JwtVerifyError, VerifiedUser


async def get_current_user(
    authorization: str | None = Header(default=None),
    deps: AppDeps = Depends(get_deps),
) -> VerifiedUser:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    token = authorization[len("Bearer "):]
    try:
        return deps.jwt_verifier.verify(token)
    except JwtVerifyError as exc:
        raise HTTPException(status_code=401, detail=str(exc))
