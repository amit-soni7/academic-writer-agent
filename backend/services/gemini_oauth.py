"""
gemini_oauth.py

Full Gemini OAuth 2.0 lifecycle management:
- Building the Google authorization URL (with generative-language scope)
- Exchanging authorization codes for access + refresh tokens
- Refreshing expired access tokens automatically
- Storing / loading encrypted token JSON per user in DB
- Revoking the OAuth connection

The Google OAuth client credentials (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)
are reused from the existing Sign-In flow.

Redirect URI registered in Google Cloud Console:
    http://localhost:8010/api/auth/gemini/callback
"""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime
from typing import Optional
from urllib.parse import urlencode

import httpx
from sqlalchemy import insert, select, update

from services.db import create_engine_async, user_settings
from services.secure_settings import _decrypt, _encrypt, _json_loads_map

logger = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

GOOGLE_CLIENT_ID     = os.getenv("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "")

REDIRECT_URI     = os.getenv("GEMINI_OAUTH_REDIRECT_URI",  "http://localhost:8010/api/auth/gemini/callback")
FRONTEND_BASE_URL = os.getenv("FRONTEND_BASE_URL",          "http://localhost:5173")

GEMINI_SCOPES    = ["https://www.googleapis.com/auth/generative-language"]
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_AUTH_URL  = "https://accounts.google.com/o/oauth2/v2/auth"

# Refresh tokens this many seconds before they expire to avoid race conditions.
_EXPIRY_BUFFER_SECS = 300


# ── Authorization URL ─────────────────────────────────────────────────────────

def build_gemini_auth_url(state: str) -> str:
    """Return the Google OAuth consent-screen URL with Gemini scope."""
    params = {
        "client_id":     GOOGLE_CLIENT_ID,
        "redirect_uri":  REDIRECT_URI,
        "scope":         " ".join(GEMINI_SCOPES),
        "response_type": "code",
        "access_type":   "offline",   # request a refresh_token
        "prompt":        "consent",   # always show consent to guarantee refresh_token
        "state":         state,
    }
    return f"{GOOGLE_AUTH_URL}?{urlencode(params)}"


# ── Token exchange ────────────────────────────────────────────────────────────

async def exchange_code_for_tokens(code: str) -> dict:
    """Exchange an authorization code for {access_token, refresh_token, expires_at}."""
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            GOOGLE_TOKEN_URL,
            data={
                "code":          code,
                "client_id":     GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "redirect_uri":  REDIRECT_URI,
                "grant_type":    "authorization_code",
            },
        )
        resp.raise_for_status()
        data = resp.json()

    data["expires_at"] = int(time.time()) + int(data.get("expires_in", 3600))
    return data


async def refresh_access_token(refresh_token: str) -> dict:
    """Use a refresh token to obtain a new access token."""
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            GOOGLE_TOKEN_URL,
            data={
                "refresh_token": refresh_token,
                "client_id":     GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "grant_type":    "refresh_token",
            },
        )
        resp.raise_for_status()
        data = resp.json()

    data["expires_at"] = int(time.time()) + int(data.get("expires_in", 3600))
    return data


# ── DB helpers ────────────────────────────────────────────────────────────────

async def _get_settings_row(user_id: str) -> Optional[dict]:
    eng = create_engine_async()
    async with eng.connect() as conn:
        row = (
            await conn.execute(
                select(user_settings).where(user_settings.c.user_id == user_id)
            )
        ).mappings().first()
    return dict(row) if row else None


def _decrypt_token_map(raw: Optional[str]) -> dict:
    if not raw:
        return {}
    try:
        decrypted = _decrypt(raw)
        parsed = json.loads(decrypted)
        return parsed if isinstance(parsed, dict) else {}
    except Exception as exc:
        logger.error("Failed to decrypt OAuth token map: %s", exc)
        return {}


# ── Public API ────────────────────────────────────────────────────────────────

async def load_gemini_oauth_tokens(user_id: str) -> Optional[dict]:
    """Return the stored (decrypted) Gemini token dict, or None if not connected."""
    row = await _get_settings_row(user_id)
    if not row:
        return None
    token_map = _decrypt_token_map(row.get("provider_oauth_tokens_encrypted_json"))
    return token_map.get("gemini") or None


async def save_gemini_oauth_tokens(user_id: str, tokens: dict) -> None:
    """
    Persist encrypted Gemini OAuth tokens to DB and mark oauth_connected=True
    in the provider profile.
    """
    row = await _get_settings_row(user_id)

    # Merge into the existing token map (preserving other provider tokens)
    existing_map = _decrypt_token_map(
        row.get("provider_oauth_tokens_encrypted_json") if row else None
    )
    existing_map["gemini"] = tokens
    encrypted_tokens = _encrypt(json.dumps(existing_map))

    # Update provider_profiles_json: gemini.oauth_connected = True
    profiles = _json_loads_map(row.get("provider_profiles_json") if row else None)
    gemini_profile = profiles.get("gemini")
    if isinstance(gemini_profile, dict):
        gemini_profile["oauth_connected"] = True
        gemini_profile["auth_method"] = "oauth"
    else:
        gemini_profile = {"oauth_connected": True, "auth_method": "oauth"}
    profiles["gemini"] = gemini_profile
    profiles_json = json.dumps(profiles)

    eng = create_engine_async()
    async with eng.begin() as conn:
        if row:
            await conn.execute(
                update(user_settings)
                .where(user_settings.c.user_id == user_id)
                .values(
                    provider_oauth_tokens_encrypted_json=encrypted_tokens,
                    provider_profiles_json=profiles_json,
                )
            )
        else:
            # First-time user with no settings row — create a minimal one.
            await conn.execute(
                insert(user_settings).values(
                    user_id=user_id,
                    provider="gemini",
                    model="gemini-2.5-flash",
                    updated_at=datetime.utcnow(),
                    provider_oauth_tokens_encrypted_json=encrypted_tokens,
                    provider_profiles_json=profiles_json,
                )
            )


async def revoke_gemini_oauth(user_id: str) -> None:
    """Clear stored Gemini OAuth tokens and set oauth_connected=False."""
    row = await _get_settings_row(user_id)
    if not row:
        return

    # Remove gemini from the token map
    existing_map = _decrypt_token_map(row.get("provider_oauth_tokens_encrypted_json"))
    existing_map.pop("gemini", None)
    encrypted_tokens = _encrypt(json.dumps(existing_map)) if existing_map else None

    # Update provider_profiles_json: gemini.oauth_connected = False
    profiles = _json_loads_map(row.get("provider_profiles_json"))
    gemini_profile = profiles.get("gemini")
    if isinstance(gemini_profile, dict):
        gemini_profile["oauth_connected"] = False
        gemini_profile["auth_method"] = "api_key"
    else:
        gemini_profile = {"oauth_connected": False, "auth_method": "api_key"}
    profiles["gemini"] = gemini_profile

    eng = create_engine_async()
    async with eng.begin() as conn:
        await conn.execute(
            update(user_settings)
            .where(user_settings.c.user_id == user_id)
            .values(
                provider_oauth_tokens_encrypted_json=encrypted_tokens,
                provider_profiles_json=json.dumps(profiles),
            )
        )


async def get_valid_gemini_access_token(user_id: str) -> Optional[str]:
    """
    Return a valid Gemini access token for the user.
    Automatically refreshes the token if it is expired or about to expire.
    Returns None if the user has not connected via OAuth.
    """
    tokens = await load_gemini_oauth_tokens(user_id)
    if not tokens:
        return None

    access_token  = tokens.get("access_token")
    refresh_token = tokens.get("refresh_token")
    expires_at    = int(tokens.get("expires_at", 0))

    if not access_token:
        return None

    # Refresh if the token expires within the buffer window
    if int(time.time()) + _EXPIRY_BUFFER_SECS >= expires_at:
        if not refresh_token:
            logger.warning(
                "Gemini OAuth token expired for user %s and no refresh token stored.", user_id
            )
            return None
        try:
            new_tokens = await refresh_access_token(refresh_token)
            # Preserve refresh_token if Google did not return a new one
            new_tokens.setdefault("refresh_token", refresh_token)
            await save_gemini_oauth_tokens(user_id, new_tokens)
            return new_tokens.get("access_token")
        except Exception as exc:
            logger.error("Failed to refresh Gemini OAuth token for user %s: %s", user_id, exc)
            return None

    return access_token
