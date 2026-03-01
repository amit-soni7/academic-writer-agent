"""
routers/settings.py

Per-user AI provider configuration.
Settings are stored encrypted in the database and scoped by authenticated user.
Legacy migration: if no DB settings exist, import `backend/settings.json` once.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Iterable

import secrets

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
import httpx
from openai import AsyncOpenAI

from models import (
    AIProviderConfig,
    AppSettingsResponse,
    AppSettingsUpdateRequest,
    ModelOption,
    ProviderModelsRequest,
    ProviderModelsResponse,
    RevealApiKeyRequest,
    RevealApiKeyResponse,
)
from services.ai_provider import AIProvider
from services.auth import get_current_user
from services.secure_settings import (
    get_user_app_settings,
    get_user_ai_settings,
    get_user_ai_settings_masked,
    get_user_provider_api_key,
    save_user_app_settings,
    save_user_ai_settings,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["settings"])

_LEGACY_SETTINGS_FILE = Path(__file__).parent.parent / "settings.json"
_GEMINI_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"

_FALLBACK_MODELS: dict[str, list[str]] = {
    "openai": ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-5", "gpt-5-mini"],
    "gemini": ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
    "claude": ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5-20251001"],
    "ollama": ["qwen2.5:7b", "llama3.2", "mistral", "phi4"],
    "llamacpp": ["qwen2.5-3b-instruct-q4_k_m.gguf"],
}


def _load_legacy_settings() -> AIProviderConfig | None:
    if _LEGACY_SETTINGS_FILE.exists():
        try:
            cfg = AIProviderConfig.model_validate_json(_LEGACY_SETTINGS_FILE.read_text())
            cfg.has_api_key = bool(cfg.api_key)
            return cfg
        except Exception as exc:
            logger.warning("Could not parse legacy settings.json: %s", exc)
    return None


async def load_settings_for_user(user_id: str) -> AIProviderConfig:
    cfg = await get_user_ai_settings(user_id)
    if cfg:
        return cfg
    legacy = _load_legacy_settings()
    if legacy:
        try:
            saved = await save_user_ai_settings(user_id, legacy)
            logger.info("Migrated legacy settings.json to DB for user %s", user_id)
            return saved
        except Exception as exc:
            logger.warning("Failed to migrate legacy settings for %s: %s", user_id, exc)
    return AIProviderConfig()


def load_settings() -> AIProviderConfig:
    """
    Backward-compatible helper for code paths that are not yet user-scoped.
    Prefer `load_settings_for_user` in authenticated routes.
    """
    legacy = _load_legacy_settings()
    return legacy or AIProviderConfig()


def _fallback_model_options(provider: str) -> list[ModelOption]:
    return [ModelOption(value=m, label=m) for m in _FALLBACK_MODELS.get(provider, [])]


def _model_options_from_names(names: Iterable[str]) -> list[ModelOption]:
    seen: set[str] = set()
    out: list[ModelOption] = []
    for name in names:
        if not name or name in seen:
            continue
        seen.add(name)
        out.append(ModelOption(value=name, label=name))
    return out


async def _list_openai_compat_models(base_url: str | None, api_key: str) -> list[ModelOption]:
    client = AsyncOpenAI(api_key=api_key, base_url=base_url)
    result = await client.models.list()
    names = [getattr(item, "id", "") for item in getattr(result, "data", [])]
    return _model_options_from_names(names)


async def _list_ollama_models(base_url: str | None) -> list[ModelOption]:
    host = (base_url or "http://localhost:11434").rstrip("/")
    async with httpx.AsyncClient(timeout=8.0) as client:
        resp = await client.get(f"{host}/api/tags")
        resp.raise_for_status()
        data = resp.json()
    models = data.get("models") or []
    names = []
    for item in models:
        if isinstance(item, dict):
            names.append(str(item.get("name") or item.get("model") or ""))
    return _model_options_from_names(names)


async def _list_anthropic_models(api_key: str) -> list[ModelOption]:
    if not api_key:
        return []
    async with httpx.AsyncClient(timeout=8.0) as client:
        resp = await client.get(
            "https://api.anthropic.com/v1/models",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
            },
        )
        resp.raise_for_status()
        data = resp.json()
    names: list[str] = []
    for item in data.get("data", []) or []:
        if isinstance(item, dict):
            names.append(str(item.get("id") or ""))
    return _model_options_from_names(names)


@router.get("/settings", response_model=AppSettingsResponse)
async def get_settings(user=Depends(get_current_user)) -> AppSettingsResponse:
    bundled = await get_user_app_settings(user["id"])
    if bundled:
        return bundled

    masked = await get_user_ai_settings_masked(user["id"])
    if masked:
        return AppSettingsResponse(**masked.model_dump(), provider_configs={})
    legacy = _load_legacy_settings()
    if legacy:
        return AppSettingsResponse(
            provider=legacy.provider,
            model=legacy.model,
            api_key="",
            base_url=legacy.base_url,
            has_api_key=bool(legacy.api_key),
            pdf_save_enabled=legacy.pdf_save_enabled,
            pdf_save_path=legacy.pdf_save_path,
            sci_hub_enabled=legacy.sci_hub_enabled,
            http_proxy=legacy.http_proxy,
            provider_configs={},
        )
    return AppSettingsResponse(**AIProviderConfig().model_dump(), provider_configs={})


@router.post("/settings", response_model=AppSettingsResponse)
async def update_settings(config: AppSettingsUpdateRequest, user=Depends(get_current_user)) -> AppSettingsResponse:
    await save_user_app_settings(user["id"], config)
    bundled = await get_user_app_settings(user["id"])
    if bundled is None:
        raise HTTPException(status_code=500, detail="Failed to reload saved settings.")
    return bundled


@router.post("/settings/reveal-key", response_model=RevealApiKeyResponse)
async def reveal_provider_api_key(payload: RevealApiKeyRequest, user=Depends(get_current_user)) -> RevealApiKeyResponse:
    provider = (payload.provider or "").strip().lower()
    if not provider:
        raise HTTPException(status_code=400, detail="Provider is required.")
    api_key = await get_user_provider_api_key(user["id"], provider)
    return RevealApiKeyResponse(provider=provider, api_key=api_key)


@router.post("/settings/models", response_model=ProviderModelsResponse)
async def list_provider_models(payload: ProviderModelsRequest, user=Depends(get_current_user)) -> ProviderModelsResponse:
    provider = (payload.provider or "").strip().lower()
    if not provider:
        raise HTTPException(status_code=400, detail="Provider is required.")

    api_key = payload.api_key
    if not api_key and provider in ("openai", "gemini", "claude"):
        api_key = await get_user_provider_api_key(user["id"], provider)

    try:
        if provider == "openai":
            models = await _list_openai_compat_models(None, api_key)
            if models:
                return ProviderModelsResponse(provider=provider, source="api", models=models)
        elif provider == "gemini":
            if api_key:
                models = await _list_openai_compat_models(_GEMINI_OPENAI_BASE_URL, api_key)
                if models:
                    return ProviderModelsResponse(provider=provider, source="api", models=models)
        elif provider == "claude":
            models = await _list_anthropic_models(api_key)
            if models:
                return ProviderModelsResponse(provider=provider, source="api", models=models)
        elif provider == "ollama":
            models = await _list_ollama_models(payload.base_url)
            if models:
                return ProviderModelsResponse(provider=provider, source="api", models=models)
        elif provider == "llamacpp":
            models = await _list_openai_compat_models(
                ((payload.base_url or "http://localhost:8080").rstrip("/") + "/v1"),
                api_key or "llama-local",
            )
            if models:
                return ProviderModelsResponse(provider=provider, source="api", models=models)
    except Exception as exc:
        logger.info("Model discovery failed for %s: %s", provider, exc)

    return ProviderModelsResponse(provider=provider, source="fallback", models=_fallback_model_options(provider))


# ── Gemini OAuth endpoints ────────────────────────────────────────────────────

_GEMINI_OAUTH_STATE_COOKIE = "_gg_oauth_state"


@router.get("/auth/gemini/connect")
async def gemini_oauth_connect(response: Response, user=Depends(get_current_user)) -> dict:
    """
    Initiate Gemini OAuth flow.
    Generates a CSRF state token, stores it in a short-lived httpOnly cookie,
    and returns the Google consent-screen URL for the frontend to redirect to.
    """
    from services.gemini_oauth import build_gemini_auth_url

    state = secrets.token_hex(16)
    auth_url = build_gemini_auth_url(state)

    response.set_cookie(
        key=_GEMINI_OAUTH_STATE_COOKIE,
        value=state,
        max_age=600,        # 10 minutes
        httponly=True,
        samesite="lax",
    )
    return {"auth_url": auth_url}


@router.get("/auth/gemini/callback")
async def gemini_oauth_callback(
    request: Request,
    user=Depends(get_current_user),
    code: str = "",
    state: str = "",
    error: str = "",
) -> RedirectResponse:
    """
    Google OAuth callback. Validates CSRF state, exchanges the authorization
    code for tokens, saves them, then redirects the browser back to the frontend.
    """
    from services.gemini_oauth import exchange_code_for_tokens, save_gemini_oauth_tokens, FRONTEND_BASE_URL

    if error:
        logger.warning("Gemini OAuth error for user %s: %s", user["id"], error)
        return RedirectResponse(
            url=f"{FRONTEND_BASE_URL}/?gemini_oauth=error&msg={error}",
            status_code=302,
        )

    # CSRF check
    stored_state = request.cookies.get(_GEMINI_OAUTH_STATE_COOKIE, "")
    if not stored_state or stored_state != state:
        logger.warning("Gemini OAuth state mismatch for user %s", user["id"])
        return RedirectResponse(
            url=f"{FRONTEND_BASE_URL}/?gemini_oauth=error&msg=invalid_state",
            status_code=302,
        )

    try:
        tokens = await exchange_code_for_tokens(code)
        await save_gemini_oauth_tokens(user["id"], tokens)
    except Exception as exc:
        logger.error("Gemini OAuth token exchange failed for user %s: %s", user["id"], exc)
        return RedirectResponse(
            url=f"{FRONTEND_BASE_URL}/?gemini_oauth=error&msg=token_exchange_failed",
            status_code=302,
        )

    redirect = RedirectResponse(
        url=f"{FRONTEND_BASE_URL}/?gemini_oauth=success",
        status_code=302,
    )
    redirect.delete_cookie(_GEMINI_OAUTH_STATE_COOKIE)
    return redirect


@router.post("/auth/gemini/disconnect")
async def gemini_oauth_disconnect(user=Depends(get_current_user)) -> dict:
    """Clear stored Gemini OAuth tokens and reset oauth_connected to False."""
    from services.gemini_oauth import revoke_gemini_oauth

    await revoke_gemini_oauth(user["id"])
    return {"status": "disconnected"}


@router.post("/settings/test")
async def test_settings(config: AppSettingsUpdateRequest, user=Depends(get_current_user)) -> dict:
    """
    Validate provider settings by sending a trivial prompt.
    Uses the submitted key if provided, otherwise falls back to the user's saved key.
    """
    effective = AIProviderConfig(**config.model_dump(exclude={"provider_configs"}))

    provider_cfg = (config.provider_configs or {}).get(config.provider)
    if provider_cfg and provider_cfg.api_key:
        effective.api_key = provider_cfg.api_key
    if provider_cfg and provider_cfg.base_url is not None:
        effective.base_url = provider_cfg.base_url
    if provider_cfg and provider_cfg.model:
        effective.model = provider_cfg.model

    if not effective.api_key and effective.provider not in ("ollama", "llamacpp"):
        existing = await get_user_ai_settings(user["id"])
        if existing and existing.api_key:
            effective = AIProviderConfig(
                provider=config.provider,
                model=config.model,
                api_key=existing.api_key,
                base_url=config.base_url,
                has_api_key=True,
            )

    if not effective.api_key and effective.provider not in ("ollama", "llamacpp"):
        raise HTTPException(status_code=400, detail="No API key provided.")

    provider = AIProvider(effective)
    ok, message = await provider.test_connection()
    if not ok:
        raise HTTPException(status_code=400, detail=f"Connection failed: {message}")
    return {"status": "ok", "message": f"Connected — model replied: {message}"}
