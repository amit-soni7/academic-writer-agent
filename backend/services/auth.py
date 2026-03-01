"""
auth.py

Minimal Google Sign-In verification and JWT issuance.

Env vars:
  GOOGLE_CLIENT_ID – OAuth client id used by the frontend
  JWT_SECRET       – HMAC secret for signing API tokens

The frontend obtains a Google ID token via Google Identity Services and
POSTs it to /api/auth/google. We verify it via Google's tokeninfo endpoint,
create/update the user, and return a signed JWT. Sessions endpoints require
Authorization: Bearer <token>.
"""

from __future__ import annotations

import os
import time
from datetime import datetime
from typing import Optional, Tuple

import httpx
import jwt
from fastapi import HTTPException, Header, Cookie

from services.db import create_engine_async, users, new_user_id
from sqlalchemy import select, insert, update


JWT_SECRET = os.getenv("JWT_SECRET", "change-me-in-prod")
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
AUTH_DISABLED = os.getenv("AUTH_DISABLED", "0") == "1"
DEV_USER_ID = os.getenv("DEV_USER_ID", "dev-user")
AUTH_COOKIE_NAME = os.getenv("AUTH_COOKIE_NAME", "awa_session")


async def verify_google_id_token(id_token: str) -> dict:
    """Verify Google ID token using Google's tokeninfo endpoint."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get("https://oauth2.googleapis.com/tokeninfo", params={"id_token": id_token})
        if r.status_code != 200:
            raise HTTPException(status_code=401, detail="Invalid Google token")
        data = r.json()
        if GOOGLE_CLIENT_ID and data.get("aud") != GOOGLE_CLIENT_ID:
            raise HTTPException(status_code=401, detail="Wrong Google client id")
        return data


def _encode_jwt(payload: dict, ttl_sec: int = 60 * 60 * 24 * 7) -> str:
    iat = int(time.time())
    exp = iat + ttl_sec
    to_enc = {**payload, "iat": iat, "exp": exp}
    return jwt.encode(to_enc, JWT_SECRET, algorithm="HS256")


def decode_jwt(token: str) -> dict:
    return jwt.decode(token, JWT_SECRET, algorithms=["HS256"])  # type: ignore


async def login_with_google(id_token: str) -> Tuple[str, dict]:
    info = await verify_google_id_token(id_token)
    email = info.get("email")
    if not email:
        raise HTTPException(status_code=400, detail="Google token missing email")
    name = info.get("name")
    picture = info.get("picture")

    eng = create_engine_async()
    async with eng.begin() as conn:
        row = (await conn.execute(select(users).where(users.c.email == email))).mappings().first()
        if row:
            user_id = row["id"]
            # update profile fields if changed
            await conn.execute(
                update(users)
                .where(users.c.id == user_id)
                .values(name=name, picture=picture)
            )
        else:
            user_id = new_user_id()
            await conn.execute(
                insert(users).values(
                    id=user_id, email=email, name=name, picture=picture, created_at=datetime.utcnow()
                )
            )

    token = _encode_jwt({"sub": user_id, "email": email})
    return token, {"id": user_id, "email": email, "name": name, "picture": picture}


# ── Dependency ───────────────────────────────────────────────────────────────

async def _ensure_dev_user() -> None:
    eng = create_engine_async()
    async with eng.begin() as conn:
        row = (await conn.execute(select(users).where(users.c.id == DEV_USER_ID))).first()
        if not row:
            await conn.execute(insert(users).values(
                id=DEV_USER_ID,
                email="dev@local",
                name="Dev User",
                picture=None,
                created_at=datetime.utcnow(),
            ))


async def _ensure_user_exists(user_id: str, email: str) -> None:
    """Re-create the users row if it was deleted while the JWT is still valid."""
    eng = create_engine_async()
    async with eng.begin() as conn:
        row = (await conn.execute(select(users).where(users.c.id == user_id))).first()
        if not row:
            await conn.execute(insert(users).values(
                id=user_id,
                email=email or "",
                name=None,
                picture=None,
                created_at=datetime.utcnow(),
            ))


async def get_current_user(
    authorization: Optional[str] = Header(None),
    awa_session: Optional[str] = Cookie(None, alias=AUTH_COOKIE_NAME),
) -> dict:
    if AUTH_DISABLED:
        # Developer mode: single implicit user
        await _ensure_dev_user()
        return {"id": DEV_USER_ID, "email": "dev@local"}
    token = awa_session
    if not token and authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1]
    if not token:
        raise HTTPException(status_code=401, detail="Missing token")
    try:
        payload = decode_jwt(token)
        user_id = payload.get("sub")
        email   = payload.get("email", "")
        await _ensure_user_exists(user_id, email)
        return {"id": user_id, "email": email}
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid token")
