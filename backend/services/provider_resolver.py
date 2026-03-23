from __future__ import annotations

import logging
import os

from models import AIProviderConfig
from services.ai_provider import AIProvider
from services.gemini_oauth import get_valid_gemini_access_token

logger = logging.getLogger(__name__)


def _google_cloud_project_id() -> str:
    return os.getenv("GOOGLE_CLOUD_PROJECT_ID", "").strip()


async def prepare_runtime_provider_config(user_id: str, config: AIProviderConfig) -> AIProviderConfig:
    runtime = AIProviderConfig(**config.model_dump())
    runtime.auth_method = (runtime.auth_method or "api_key").strip().lower() or "api_key"

    if runtime.provider != "gemini":
        return runtime

    runtime.gemini_cloud_project_id = _google_cloud_project_id() or None
    if runtime.auth_method != "oauth":
        return runtime

    try:
        runtime.gemini_oauth_access_token = await get_valid_gemini_access_token(user_id)
    except Exception as exc:
        logger.warning("Failed to resolve Gemini OAuth token for user %s: %s", user_id, exc)
        runtime.gemini_oauth_access_token = None
    return runtime


def provider_has_usable_credentials(config: AIProviderConfig) -> bool:
    provider = (config.provider or "").strip().lower()
    auth_method = (config.auth_method or "api_key").strip().lower() or "api_key"

    if provider in ("ollama", "llamacpp"):
        return True
    if provider == "gemini":
        if auth_method == "oauth":
            return bool(config.gemini_oauth_access_token or config.oauth_connected or config.api_key)
        return bool(config.api_key)
    return bool(config.api_key)


async def build_provider_for_user_config(user_id: str, config: AIProviderConfig) -> AIProvider | None:
    runtime = await prepare_runtime_provider_config(user_id, config)
    if not provider_has_usable_credentials(runtime):
        return None
    return AIProvider(runtime)
