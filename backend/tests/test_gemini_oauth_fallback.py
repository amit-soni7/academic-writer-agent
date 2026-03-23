import pytest

from models import AIProviderConfig
from services.ai_provider import AIProvider
from services.llm_errors import LLMAuthError, LLMRateLimitError
from services.provider_resolver import (
    prepare_runtime_provider_config,
    provider_has_usable_credentials,
)


@pytest.mark.asyncio
async def test_prepare_runtime_provider_config_attaches_gemini_oauth_token(monkeypatch):
    async def _fake_token(_user_id: str) -> str:
        return "oauth-token"

    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT_ID", "test-project")
    monkeypatch.setattr("services.provider_resolver.get_valid_gemini_access_token", _fake_token)

    config = AIProviderConfig(
        provider="gemini",
        model="gemini-2.5-flash",
        auth_method="oauth",
        oauth_connected=True,
    )

    runtime = await prepare_runtime_provider_config("user-123", config)

    assert runtime.gemini_oauth_access_token == "oauth-token"
    assert runtime.gemini_cloud_project_id == "test-project"


def test_provider_has_usable_credentials_allows_gemini_oauth_with_saved_fallback_key():
    config = AIProviderConfig(
        provider="gemini",
        model="gemini-2.5-flash",
        auth_method="oauth",
        oauth_connected=False,
        api_key="AIza-fallback",
        has_api_key=True,
    )

    assert provider_has_usable_credentials(config) is True


@pytest.mark.asyncio
async def test_gemini_oauth_auth_failure_falls_back_to_api_key(monkeypatch):
    async def _fake_native(self, system, messages, *, json_mode, temperature, max_tokens):
        raise LLMAuthError("oauth failed", provider="gemini", model=self.config.model, status_code=401)

    async def _fake_compat(self, system, messages, *, base_url, api_key, json_mode, temperature, max_tokens):
        assert api_key == "AIza-fallback"
        return "OK", "stop", 7

    monkeypatch.setattr(AIProvider, "_gemini_native_raw", _fake_native)
    monkeypatch.setattr(AIProvider, "_openai_compat_raw", _fake_compat)

    provider = AIProvider(
        AIProviderConfig(
            provider="gemini",
            model="gemini-2.5-flash",
            auth_method="oauth",
            api_key="AIza-fallback",
            oauth_connected=True,
            gemini_oauth_access_token="oauth-token",
            gemini_cloud_project_id="test-project",
        )
    )

    text, stop_reason, tokens = await provider._raw_call(
        "system",
        [{"role": "user", "content": "hello"}],
        json_mode=False,
        temperature=0.3,
        max_tokens=64,
    )

    assert text == "OK"
    assert stop_reason == "stop"
    assert tokens == 7
    assert provider.last_auth_source == "api_key_fallback"


@pytest.mark.asyncio
async def test_gemini_oauth_does_not_fallback_on_rate_limit(monkeypatch):
    async def _fake_native(self, system, messages, *, json_mode, temperature, max_tokens):
        raise LLMRateLimitError("slow down", provider="gemini", model=self.config.model, status_code=429)

    async def _unexpected_compat(self, system, messages, *, base_url, api_key, json_mode, temperature, max_tokens):
        raise AssertionError("API key fallback should not be attempted for non-auth Gemini errors")

    monkeypatch.setattr(AIProvider, "_gemini_native_raw", _fake_native)
    monkeypatch.setattr(AIProvider, "_openai_compat_raw", _unexpected_compat)

    provider = AIProvider(
        AIProviderConfig(
            provider="gemini",
            model="gemini-2.5-flash",
            auth_method="oauth",
            api_key="AIza-fallback",
            oauth_connected=True,
            gemini_oauth_access_token="oauth-token",
            gemini_cloud_project_id="test-project",
        )
    )

    with pytest.raises(LLMRateLimitError):
        await provider._raw_call(
            "system",
            [{"role": "user", "content": "hello"}],
            json_mode=False,
            temperature=0.3,
            max_tokens=64,
        )
