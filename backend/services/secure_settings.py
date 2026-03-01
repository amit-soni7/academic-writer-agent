"""
Per-user encrypted AI provider settings storage.

Supports both:
1) legacy single-provider fields (provider/model/api_key/base_url)
2) v2 per-provider settings (profiles + encrypted key map)
"""

from __future__ import annotations

from datetime import datetime
import json
import os
from typing import Any, Optional

from sqlalchemy import insert, select, update

from models import AIProviderConfig, AppSettingsResponse, AppSettingsUpdateRequest, ProviderConfigEntry
from services.db import create_engine_async, user_settings


SUPPORTED_PROVIDERS = ("openai", "gemini", "claude", "ollama", "llamacpp")

DEFAULT_PROVIDER_MODELS: dict[str, str] = {
    "openai": "gpt-4o",
    "gemini": "gemini-2.5-flash",
    "claude": "claude-sonnet-4-6",
    "ollama": "qwen2.5:7b",
    "llamacpp": "qwen2.5-3b-instruct-q4_k_m.gguf",
}

DEFAULT_PROVIDER_HOSTS: dict[str, str] = {
    "ollama": "http://localhost:11434",
    "llamacpp": "http://localhost:8080",
}


def _now() -> datetime:
    return datetime.utcnow()


def _get_fernet():
    key = os.getenv("SETTINGS_ENCRYPTION_KEY", "").strip()
    if not key:
        raise RuntimeError("SETTINGS_ENCRYPTION_KEY is not set")
    try:
        from cryptography.fernet import Fernet
    except Exception as exc:  # pragma: no cover
        raise RuntimeError("cryptography package is required for encrypted settings") from exc
    return Fernet(key.encode("utf-8"))


def _encrypt(value: str) -> str:
    if not value:
        return ""
    f = _get_fernet()
    return f.encrypt(value.encode("utf-8")).decode("utf-8")


def _decrypt(value: Optional[str]) -> str:
    if not value:
        return ""
    f = _get_fernet()
    return f.decrypt(value.encode("utf-8")).decode("utf-8")


def _masked_config(cfg: AIProviderConfig, has_api_key: bool) -> AIProviderConfig:
    return AIProviderConfig(
        provider=cfg.provider,
        model=cfg.model,
        api_key="",
        base_url=cfg.base_url,
        has_api_key=has_api_key,
        pdf_save_enabled=cfg.pdf_save_enabled,
        pdf_save_path=cfg.pdf_save_path,
        sci_hub_enabled=cfg.sci_hub_enabled,
        http_proxy=cfg.http_proxy,
    )


def _bool_from_text(val: Optional[str], default: bool = False) -> bool:
    if val is None:
        return default
    return str(val).strip().lower() == "true"


def _default_provider_profiles() -> dict[str, ProviderConfigEntry]:
    out: dict[str, ProviderConfigEntry] = {}
    for provider in SUPPORTED_PROVIDERS:
        out[provider] = ProviderConfigEntry(
            auth_method="api_key",
            api_key="",
            has_api_key=False,
            model=DEFAULT_PROVIDER_MODELS.get(provider),
            base_url=DEFAULT_PROVIDER_HOSTS.get(provider),
            oauth_connected=False,
        )
    return out


def _json_loads_map(raw: Optional[str]) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        value = json.loads(raw)
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def _decrypt_key_map(raw: Optional[str]) -> dict[str, str]:
    if not raw:
        return {}
    try:
        decrypted = _decrypt(raw)
        parsed = json.loads(decrypted)
        if not isinstance(parsed, dict):
            return {}
        return {str(k): str(v or "") for k, v in parsed.items()}
    except Exception as exc:
        import logging
        logging.getLogger(__name__).error(
            "Failed to decrypt provider key map (check SETTINGS_ENCRYPTION_KEY): %s", exc
        )
        return {}


def _encrypt_key_map(values: dict[str, str]) -> Optional[str]:
    clean = {k: v for k, v in values.items() if v}
    if not clean:
        return None
    return _encrypt(json.dumps(clean))


def _build_profiles_from_row(row: dict[str, Any]) -> dict[str, ProviderConfigEntry]:
    profiles = _default_provider_profiles()
    stored_profiles = _json_loads_map(row.get("provider_profiles_json"))
    stored_keys = _decrypt_key_map(row.get("provider_api_keys_encrypted_json"))

    for provider, raw in stored_profiles.items():
        if provider not in profiles or not isinstance(raw, dict):
            continue
        existing = profiles[provider]
        profiles[provider] = ProviderConfigEntry(
            auth_method=str(raw.get("auth_method") or existing.auth_method),
            api_key="",  # never return plaintext in bulk fetch
            has_api_key=bool(stored_keys.get(provider)),
            model=raw.get("model") or existing.model,
            base_url=raw.get("base_url", existing.base_url),
            oauth_connected=bool(raw.get("oauth_connected", False)),
        )

    # Legacy fallback: synthesize current provider into profile map if v2 data absent.
    legacy_provider = str(row.get("provider") or "openai")
    if legacy_provider in profiles:
        legacy_key = _decrypt(row.get("api_key_encrypted"))
        legacy_base = row.get("base_url")
        legacy_model = row.get("model")
        p = profiles[legacy_provider]
        profiles[legacy_provider] = ProviderConfigEntry(
            auth_method=p.auth_method,
            api_key="",
            has_api_key=bool(stored_keys.get(legacy_provider) or legacy_key),
            model=legacy_model or p.model,
            base_url=legacy_base if legacy_base is not None else p.base_url,
            oauth_connected=p.oauth_connected,
        )

    return profiles


def _build_key_map_from_row(row: dict[str, Any]) -> dict[str, str]:
    key_map = _decrypt_key_map(row.get("provider_api_keys_encrypted_json"))
    legacy_provider = str(row.get("provider") or "openai")
    legacy_key = _decrypt(row.get("api_key_encrypted"))
    if legacy_key and legacy_provider and legacy_provider not in key_map:
        key_map[legacy_provider] = legacy_key
    return key_map


def _build_active_config(row: dict[str, Any], key_map: dict[str, str], profiles: dict[str, ProviderConfigEntry]) -> AIProviderConfig:
    provider = str(row.get("provider") or "openai")
    profile = profiles.get(provider)
    api_key = key_map.get(provider, "")
    return AIProviderConfig(
        provider=provider,
        model=(profile.model if profile and profile.model else row.get("model") or DEFAULT_PROVIDER_MODELS.get(provider, "gpt-4o")),
        api_key=api_key,
        base_url=(profile.base_url if profile else row.get("base_url")),
        has_api_key=bool(api_key),
        pdf_save_enabled=_bool_from_text(row.get("pdf_save_enabled")),
        pdf_save_path=row.get("pdf_save_path"),
        sci_hub_enabled=_bool_from_text(row.get("sci_hub_enabled")),
        http_proxy=row.get("http_proxy"),
    )


async def _get_user_settings_row(user_id: str) -> Optional[dict[str, Any]]:
    eng = create_engine_async()
    async with eng.connect() as conn:
        row = (
            await conn.execute(select(user_settings).where(user_settings.c.user_id == user_id))
        ).mappings().first()
    return dict(row) if row else None


async def get_user_ai_settings(user_id: str) -> Optional[AIProviderConfig]:
    row = await _get_user_settings_row(user_id)
    if not row:
        return None
    profiles = _build_profiles_from_row(row)
    key_map = _build_key_map_from_row(row)
    return _build_active_config(row, key_map, profiles)


async def get_user_ai_settings_masked(user_id: str) -> Optional[AIProviderConfig]:
    cfg = await get_user_ai_settings(user_id)
    if cfg is None:
        return None
    return _masked_config(cfg, has_api_key=bool(cfg.api_key))


async def get_user_app_settings(user_id: str) -> Optional[AppSettingsResponse]:
    row = await _get_user_settings_row(user_id)
    if not row:
        return None
    profiles = _build_profiles_from_row(row)
    key_map = _build_key_map_from_row(row)
    active = _build_active_config(row, key_map, profiles)
    return AppSettingsResponse(
        **active.model_dump(exclude={"api_key", "has_api_key"}),
        api_key="",  # bulk response remains masked
        has_api_key=bool(active.api_key),
        provider_configs=profiles,
    )


async def get_user_provider_api_key(user_id: str, provider: str) -> str:
    row = await _get_user_settings_row(user_id)
    if not row:
        return ""
    key_map = _build_key_map_from_row(row)
    return key_map.get(provider, "")


async def save_user_ai_settings(user_id: str, config: AIProviderConfig) -> AIProviderConfig:
    existing_bundle = await get_user_app_settings(user_id)
    provider_profiles = existing_bundle.provider_configs if existing_bundle else _default_provider_profiles()

    current_profile = provider_profiles.get(config.provider, ProviderConfigEntry(model=config.model, base_url=config.base_url))
    provider_profiles[config.provider] = ProviderConfigEntry(
        auth_method=current_profile.auth_method,
        api_key="",  # not persisted here directly; key map handles it
        has_api_key=bool(config.api_key) or bool(current_profile.has_api_key),
        model=config.model,
        base_url=config.base_url,
        oauth_connected=current_profile.oauth_connected,
    )

    update_req = AppSettingsUpdateRequest(
        **config.model_dump(),
        provider_configs=provider_profiles,
    )
    return await save_user_app_settings(user_id, update_req)


async def save_user_app_settings(user_id: str, config: AppSettingsUpdateRequest) -> AIProviderConfig:
    existing_row = await _get_user_settings_row(user_id)
    existing_keys = _build_key_map_from_row(existing_row) if existing_row else {}
    existing_profiles = _build_profiles_from_row(existing_row) if existing_row else _default_provider_profiles()

    incoming_profiles = _default_provider_profiles()
    incoming_profiles.update(existing_profiles)

    for provider, incoming in (config.provider_configs or {}).items():
        if provider not in incoming_profiles:
            continue
        incoming_profiles[provider] = ProviderConfigEntry(
            auth_method=incoming.auth_method or incoming_profiles[provider].auth_method,
            api_key="",
            has_api_key=incoming_profiles[provider].has_api_key,
            model=incoming.model or incoming_profiles[provider].model,
            base_url=incoming.base_url if incoming.base_url is not None else incoming_profiles[provider].base_url,
            oauth_connected=bool(incoming.oauth_connected or False),
        )
        if incoming.api_key:
            existing_keys[provider] = incoming.api_key
        elif incoming.has_api_key is False and provider in existing_keys:
            # explicit clear if frontend sends has_api_key=false and empty key
            existing_keys.pop(provider, None)

    # Sync active provider fields back into per-provider profiles and key map.
    active_provider = config.provider
    if active_provider in incoming_profiles:
        p = incoming_profiles[active_provider]
        incoming_profiles[active_provider] = ProviderConfigEntry(
            auth_method=p.auth_method,
            api_key="",
            has_api_key=p.has_api_key or bool(config.api_key),
            model=config.model or p.model,
            base_url=config.base_url if config.base_url is not None else p.base_url,
            oauth_connected=p.oauth_connected,
        )
    if config.api_key:
        existing_keys[active_provider] = config.api_key
    elif active_provider not in existing_keys and existing_row:
        # legacy fallback (preserve old active key if no v2 map present)
        legacy_key = _decrypt(existing_row.get("api_key_encrypted"))
        if legacy_key:
            existing_keys[active_provider] = legacy_key

    profiles_json = json.dumps({
        provider: {
            "auth_method": entry.auth_method,
            "model": entry.model,
            "base_url": entry.base_url,
            "oauth_connected": entry.oauth_connected,
        }
        for provider, entry in incoming_profiles.items()
        if provider in SUPPORTED_PROVIDERS
    })
    encrypted_key_map = _encrypt_key_map(existing_keys)

    active_key = existing_keys.get(active_provider, "")
    active_profile = incoming_profiles.get(active_provider)
    effective_base_url = config.base_url if config.base_url is not None else (active_profile.base_url if active_profile else None)

    eng = create_engine_async()
    async with eng.begin() as conn:
        values = {
            "user_id": user_id,
            "provider": config.provider,
            "model": config.model,
            "api_key_encrypted": _encrypt(active_key) if active_key else None,  # legacy field kept in sync
            "base_url": effective_base_url,
            "updated_at": _now(),
            "pdf_save_enabled": "true" if config.pdf_save_enabled else "false",
            "pdf_save_path": config.pdf_save_path,
            "sci_hub_enabled": "true" if config.sci_hub_enabled else "false",
            "http_proxy": config.http_proxy,
            "provider_profiles_json": profiles_json,
            "provider_api_keys_encrypted_json": encrypted_key_map,
        }
        upd = await conn.execute(
            update(user_settings)
            .where(user_settings.c.user_id == user_id)
            .values(**{k: v for k, v in values.items() if k != "user_id"})
        )
        if getattr(upd, "rowcount", 0) == 0:
            await conn.execute(insert(user_settings).values(**values))

    return AIProviderConfig(
        provider=config.provider,
        model=config.model,
        api_key=active_key,
        base_url=effective_base_url,
        has_api_key=bool(active_key),
        pdf_save_enabled=config.pdf_save_enabled,
        pdf_save_path=config.pdf_save_path,
        sci_hub_enabled=config.sci_hub_enabled,
        http_proxy=config.http_proxy,
    )
