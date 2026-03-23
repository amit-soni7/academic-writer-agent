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
from pydantic import BaseModel

from models import (
    AIProviderConfig,
    AppSettingsResponse,
    AppSettingsUpdateRequest,
    ModelOption,
    ProviderConfigEntry,
    ProviderModelsRequest,
    ProviderModelsResponse,
    RevealApiKeyRequest,
    RevealApiKeyResponse,
)
from services.auth import get_current_user
from services.llm_errors import (
    LLMAuthError,
    LLMBadRequestError,
    LLMBillingError,
    LLMConnectionError,
    LLMError,
    LLMQuotaExhaustedError,
    LLMRateLimitError,
    LLMServerError,
)
from services.provider_resolver import (
    build_provider_for_user_config,
    prepare_runtime_provider_config,
)
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
_GEMINI_NATIVE_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models"

_FALLBACK_MODELS: dict[str, list[str]] = {
    "openai": ["gpt-5.4", "gpt-5.4-mini", "gpt-5", "gpt-5-mini", "gpt-4.1"],
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


async def _build_runtime_provider_config(
    user_id: str,
    *,
    provider: str,
    model: str = "",
    api_key: str = "",
    base_url: str | None = None,
    auth_method: str = "",
    oauth_connected: bool | None = None,
) -> AIProviderConfig:
    bundled = await get_user_app_settings(user_id)
    stored_entry = (bundled.provider_configs.get(provider) if bundled else None) or ProviderConfigEntry()
    stored_key = await get_user_provider_api_key(user_id, provider)
    resolved_key = api_key or stored_key
    resolved_model = model or stored_entry.model or (_FALLBACK_MODELS.get(provider, [""])[0] if _FALLBACK_MODELS.get(provider) else "")
    resolved_auth_method = (auth_method or stored_entry.auth_method or "api_key").strip().lower() or "api_key"
    runtime = AIProviderConfig(
        provider=provider,
        model=resolved_model,
        api_key=resolved_key,
        base_url=base_url if base_url is not None else stored_entry.base_url,
        has_api_key=bool(resolved_key),
        auth_method=resolved_auth_method,
        oauth_connected=stored_entry.oauth_connected if oauth_connected is None else oauth_connected,
    )
    return await prepare_runtime_provider_config(user_id, runtime)


def _extract_google_error_message(payload: dict, fallback: str) -> str:
    if isinstance(payload, dict):
        err = payload.get("error")
        if isinstance(err, dict):
            return str(err.get("message") or fallback)
    return fallback


def _raise_gemini_status(status_code: int, message: str, retry_after: float | None = None) -> None:
    kwargs = {
        "provider": "gemini",
        "model": "",
        "status_code": status_code,
        "retry_after": retry_after,
    }
    if status_code == 429:
        low = message.lower()
        if "quota" in low or "billing" in low or "exceeded" in low:
            raise LLMQuotaExhaustedError(message, **kwargs)
        raise LLMRateLimitError(message, **kwargs)
    if status_code in (401, 403):
        raise LLMAuthError(message, **kwargs)
    if status_code == 402:
        raise LLMBillingError(message, **kwargs)
    if status_code in (500, 502, 503):
        raise LLMServerError(message, **kwargs)
    if status_code == 400:
        raise LLMBadRequestError(message, **kwargs)
    raise LLMError(message, **kwargs)


async def _list_gemini_native_models(access_token: str, project_id: str) -> list[ModelOption]:
    if not access_token:
        raise LLMAuthError("Gemini OAuth is selected, but no valid OAuth access token is available.", provider="gemini", model="", status_code=401)
    if not project_id:
        raise LLMAuthError("Gemini OAuth requires GOOGLE_CLOUD_PROJECT_ID to be configured on the server.", provider="gemini", model="", status_code=401)

    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.get(
                _GEMINI_NATIVE_MODELS_URL,
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "x-goog-user-project": project_id,
                },
            )
    except httpx.TimeoutException as exc:
        raise LLMConnectionError(str(exc), provider="gemini", model="") from exc
    except httpx.HTTPError as exc:
        raise LLMConnectionError(str(exc), provider="gemini", model="") from exc

    if resp.status_code >= 400:
        retry_after = None
        ra = resp.headers.get("retry-after")
        if ra:
            try:
                retry_after = float(ra)
            except ValueError:
                retry_after = None
        try:
            payload = resp.json()
        except ValueError:
            payload = {}
        _raise_gemini_status(resp.status_code, _extract_google_error_message(payload, resp.text or "Gemini model discovery failed."), retry_after)

    data = resp.json()
    names: list[str] = []
    for item in data.get("models", []) or []:
        if not isinstance(item, dict):
            continue
        supported = item.get("supportedGenerationMethods") or []
        if supported and "generateContent" not in supported:
            continue
        name = str(item.get("name") or "")
        if name.startswith("models/"):
            name = name.split("/", 1)[1]
        names.append(name)
    return _model_options_from_names(names)


async def _list_gemini_models(config: AIProviderConfig) -> tuple[list[ModelOption], str | None]:
    if config.auth_method == "oauth":
        try:
            models = await _list_gemini_native_models(
                config.gemini_oauth_access_token or "",
                config.gemini_cloud_project_id or "",
            )
            return models, "oauth"
        except LLMAuthError as exc:
            if not config.api_key:
                raise
            logger.warning("Gemini model discovery falling back to API key: %s", exc.raw_message[:200])
            models = await _list_openai_compat_models(_GEMINI_OPENAI_BASE_URL, config.api_key)
            return models, "api_key_fallback"

    if config.api_key:
        models = await _list_openai_compat_models(_GEMINI_OPENAI_BASE_URL, config.api_key)
        return models, "api_key"
    return [], None


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

    try:
        if provider == "openai":
            api_key = payload.api_key or await get_user_provider_api_key(user["id"], provider)
            models = await _list_openai_compat_models(None, api_key)
            if models:
                return ProviderModelsResponse(provider=provider, source="api", models=models)
        elif provider == "gemini":
            runtime = await _build_runtime_provider_config(
                user["id"],
                provider="gemini",
                api_key=payload.api_key,
                base_url=payload.base_url,
                auth_method=payload.auth_method,
            )
            models, auth_source = await _list_gemini_models(runtime)
            if models:
                return ProviderModelsResponse(provider=provider, source="api", auth_source=auth_source, models=models)
        elif provider == "claude":
            api_key = payload.api_key or await get_user_provider_api_key(user["id"], provider)
            models = await _list_anthropic_models(api_key)
            if models:
                return ProviderModelsResponse(provider=provider, source="api", models=models)
        elif provider == "ollama":
            models = await _list_ollama_models(payload.base_url)
            if models:
                return ProviderModelsResponse(provider=provider, source="api", models=models)
        elif provider == "llamacpp":
            api_key = payload.api_key or await get_user_provider_api_key(user["id"], provider)
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
            url=f"{FRONTEND_BASE_URL}/dashboard?gemini_oauth=error&msg={error}",
            status_code=302,
        )

    # CSRF check
    stored_state = request.cookies.get(_GEMINI_OAUTH_STATE_COOKIE, "")
    if not stored_state or stored_state != state:
        logger.warning("Gemini OAuth state mismatch for user %s", user["id"])
        return RedirectResponse(
            url=f"{FRONTEND_BASE_URL}/dashboard?gemini_oauth=error&msg=invalid_state",
            status_code=302,
        )

    try:
        tokens = await exchange_code_for_tokens(code)
        await save_gemini_oauth_tokens(user["id"], tokens)
    except Exception as exc:
        logger.error("Gemini OAuth token exchange failed for user %s: %s", user["id"], exc)
        return RedirectResponse(
            url=f"{FRONTEND_BASE_URL}/dashboard?gemini_oauth=error&msg=token_exchange_failed",
            status_code=302,
        )

    redirect = RedirectResponse(
        url=f"{FRONTEND_BASE_URL}/dashboard?gemini_oauth=success",
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
    Uses the submitted provider config, then merges in saved credentials when needed.
    """
    provider_cfg = (config.provider_configs or {}).get(config.provider)
    runtime = await _build_runtime_provider_config(
        user["id"],
        provider=config.provider,
        model=(provider_cfg.model if provider_cfg and provider_cfg.model else config.model),
        api_key=(provider_cfg.api_key if provider_cfg else ""),
        base_url=(provider_cfg.base_url if provider_cfg and provider_cfg.base_url is not None else config.base_url),
        auth_method=(provider_cfg.auth_method if provider_cfg else ""),
        oauth_connected=(provider_cfg.oauth_connected if provider_cfg else None),
    )

    provider = await build_provider_for_user_config(user["id"], runtime)
    if provider is None:
        raise HTTPException(status_code=400, detail="No usable credentials configured for the selected provider.")

    ok, message = await provider.test_connection()
    if not ok:
        raise HTTPException(status_code=400, detail=f"Connection failed: {message}")

    auth_source = provider.last_auth_source
    auth_label = ""
    if runtime.provider == "gemini":
        if auth_source == "oauth":
            auth_label = " using OAuth"
        elif auth_source == "api_key_fallback":
            auth_label = " using API key fallback"
        elif auth_source == "api_key":
            auth_label = " using API key"

    return {
        "status": "ok",
        "auth_source": auth_source,
        "message": f"Connected{auth_label} — model replied: {message}",
    }


class TestSciHubMirrorRequest(BaseModel):
    url: str


@router.post("/settings/test-scihub-mirror")
async def test_scihub_mirror(payload: TestSciHubMirrorRequest, user=Depends(get_current_user)) -> dict:
    """
    Test whether a Sci-Hub mirror URL can fetch a known open-access paper.
    Uses Ioannidis 2005 (PLOS Medicine) — always available on working mirrors.
    Returns {ok, latency_ms, pdf_size_bytes, error?}.
    """
    import time
    import re as _re

    url = payload.url.rstrip("/")
    if not url.startswith("http"):
        return {"ok": False, "error": "URL must start with http:// or https://"}

    HEADERS = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )
    }
    TEST_DOI = "10.1371/journal.pmed.0020124"

    try:
        import httpx
        t0 = time.monotonic()
        async with httpx.AsyncClient(headers=HEADERS, timeout=httpx.Timeout(20.0, connect=8.0), follow_redirects=True) as c:
            r = await c.get(f"{url}/{TEST_DOI}")
            if r.status_code != 200:
                return {"ok": False, "error": f"HTTP {r.status_code} from mirror"}

            ct = r.headers.get("content-type", "")
            if "pdf" in ct or r.content[:4] == b"%PDF":
                elapsed = int((time.monotonic() - t0) * 1000)
                return {"ok": True, "latency_ms": elapsed, "pdf_size_bytes": len(r.content)}

            html = r.text

            # Try citation_pdf_url meta (sci-hub.su style)
            m = _re.search(r'<meta[^>]+name=["\']citation_pdf_url["\'][^>]+content=["\']([^"\']+)["\']', html, _re.I)
            if not m:
                m = _re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+name=["\']citation_pdf_url["\']', html, _re.I)
            if m:
                path = m.group(1)
                pdf_url = (url + path) if path.startswith("/") else path
                r2 = await c.get(pdf_url, headers={**HEADERS, "Referer": f"{url}/{TEST_DOI}"})
                if r2.status_code == 200 and (r2.content[:4] == b"%PDF" or "pdf" in r2.headers.get("content-type", "")):
                    elapsed = int((time.monotonic() - t0) * 1000)
                    return {"ok": True, "latency_ms": elapsed, "pdf_size_bytes": len(r2.content)}

            # Try embed src (sci-hub.ren / bban.top style)
            m = _re.search(r'<embed[^>]+src=["\']([^"\']+\.pdf[^"\']*)["\']', html, _re.I)
            if m:
                embed_url = m.group(1).split("#")[0]
                if embed_url.startswith("//"):
                    embed_url = "https:" + embed_url
                r2 = await c.get(embed_url, headers={**HEADERS, "Referer": f"{url}/{TEST_DOI}"})
                if r2.status_code == 200 and (r2.content[:4] == b"%PDF" or "pdf" in r2.headers.get("content-type", "")):
                    elapsed = int((time.monotonic() - t0) * 1000)
                    return {"ok": True, "latency_ms": elapsed, "pdf_size_bytes": len(r2.content)}

            return {"ok": False, "error": "Mirror responded but no PDF found (may need captcha or is unsupported)"}

    except httpx.ConnectTimeout:
        return {"ok": False, "error": "Connection timed out"}
    except httpx.ConnectError:
        return {"ok": False, "error": "Cannot connect to mirror"}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
