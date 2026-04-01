"""
auth.py

Server-side Google OAuth 2.0 authorization code flow + JWT issuance.

Env vars:
  GOOGLE_CLIENT_ID            – OAuth client id
  GOOGLE_CLIENT_SECRET        – OAuth client secret
  GOOGLE_OAUTH_REDIRECT_URI   – Callback URL registered in Google Cloud Console
  FRONTEND_BASE_URL           – Where to redirect after login
  JWT_SECRET                  – HMAC secret for signing API tokens
"""

from __future__ import annotations

import os
import time
from datetime import datetime
from typing import Optional, Tuple
from urllib.parse import urlencode

import httpx
import jwt
from fastapi import HTTPException, Header, Cookie

from services.db import create_engine_async, users, new_user_id
from sqlalchemy import select, insert, update


JWT_SECRET = os.getenv("JWT_SECRET", "change-me-in-prod")
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "")
GOOGLE_OAUTH_REDIRECT_URI = os.getenv(
    "GOOGLE_OAUTH_REDIRECT_URI", "http://localhost:8010/api/auth/google/callback"
)
FRONTEND_BASE_URL = os.getenv("FRONTEND_BASE_URL", "http://localhost:5173")
AUTH_DISABLED = os.getenv("AUTH_DISABLED", "0") == "1"
DEV_USER_ID = os.getenv("DEV_USER_ID", "dev-user")
AUTH_COOKIE_NAME = os.getenv("AUTH_COOKIE_NAME", "awa_session")

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"
OAUTH_SCOPES = "openid email profile"


# ── Server-side OAuth 2.0 ────────────────────────────────────────────────────

def build_google_login_url(state: str) -> str:
    """Build Google OAuth consent URL for authorization code flow."""
    params = {
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": GOOGLE_OAUTH_REDIRECT_URI,
        "response_type": "code",
        "scope": OAUTH_SCOPES,
        "access_type": "online",
        "prompt": "select_account",
        "state": state,
    }
    return f"{GOOGLE_AUTH_URL}?{urlencode(params)}"


async def exchange_google_code(code: str) -> dict:
    """Exchange authorization code for tokens."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.post(GOOGLE_TOKEN_URL, data={
            "code": code,
            "client_id": GOOGLE_CLIENT_ID,
            "client_secret": GOOGLE_CLIENT_SECRET,
            "redirect_uri": GOOGLE_OAUTH_REDIRECT_URI,
            "grant_type": "authorization_code",
        })
        if r.status_code != 200:
            raise HTTPException(status_code=401, detail=f"Token exchange failed: {r.text}")
        return r.json()


async def fetch_google_userinfo(access_token: str) -> dict:
    """Fetch user profile from Google userinfo endpoint."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(
            GOOGLE_USERINFO_URL,
            headers={"Authorization": f"Bearer {access_token}"},
        )
        if r.status_code != 200:
            raise HTTPException(status_code=401, detail="Failed to fetch user info")
        return r.json()


def _encode_jwt(payload: dict, ttl_sec: int = 60 * 60 * 24 * 7) -> str:
    iat = int(time.time())
    exp = iat + ttl_sec
    to_enc = {**payload, "iat": iat, "exp": exp}
    return jwt.encode(to_enc, JWT_SECRET, algorithm="HS256")


def decode_jwt(token: str) -> dict:
    return jwt.decode(token, JWT_SECRET, algorithms=["HS256"])  # type: ignore


async def login_with_google_code(code: str) -> Tuple[str, dict]:
    """Exchange authorization code for tokens, fetch user info, upsert user, return JWT."""
    tokens = await exchange_google_code(code)
    access_token = tokens.get("access_token")
    if not access_token:
        raise HTTPException(status_code=401, detail="No access token in response")
    info = await fetch_google_userinfo(access_token)
    email = info.get("email")
    if not email:
        raise HTTPException(status_code=400, detail="Google account missing email")
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
