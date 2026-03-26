"""
provider_config.py

Loads provider/model metadata from backend/data/providers.json.
Used by ai_provider.py and routers/settings.py.
"""

import json
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_CONFIG_PATH = Path(__file__).parent.parent / "data" / "providers.json"
_CONFIG: dict[str, Any] = {}


def _load() -> dict[str, Any]:
    global _CONFIG
    if _CONFIG:
        return _CONFIG
    try:
        _CONFIG = json.loads(_CONFIG_PATH.read_text())
    except Exception as exc:
        logger.warning("Could not load providers.json: %s", exc)
        _CONFIG = {}
    return _CONFIG


def get_provider_config(provider: str) -> dict[str, Any]:
    """Return the full config block for a provider (baseUrl, auth, api, models)."""
    return _load().get(provider, {})


def get_model_ids(provider: str) -> list[str]:
    """Return the list of model IDs for a provider."""
    cfg = get_provider_config(provider)
    return [m["id"] for m in cfg.get("models", [])]


def get_model_meta(provider: str, model_id: str) -> dict[str, Any]:
    """Return metadata for a specific model (cost, contextWindow, maxTokens, etc.)."""
    cfg = get_provider_config(provider)
    for m in cfg.get("models", []):
        if m.get("id") == model_id:
            return m
    return {}


def get_base_url(provider: str) -> str:
    """Return the base URL for a provider."""
    return get_provider_config(provider).get("baseUrl", "")


def get_all_providers() -> dict[str, Any]:
    """Return the full providers config."""
    return _load()
