from types import SimpleNamespace

import pytest

from models import AIProviderConfig
from services.ai_provider import AIProvider


class _FakeChatCompletions:
    def __init__(self, sink: list[dict]) -> None:
        self._sink = sink

    async def create(self, **kwargs):
        self._sink.append(kwargs)
        return SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(content="OK"),
                    finish_reason="stop",
                )
            ],
            usage=SimpleNamespace(prompt_tokens=3, completion_tokens=2),
        )


class _FakeAsyncOpenAI:
    def __init__(self, *, api_key: str, base_url: str | None = None) -> None:
        self.api_key = api_key
        self.base_url = base_url
        self.chat = SimpleNamespace(completions=_FakeChatCompletions(self.calls))

    calls: list[dict] = []


@pytest.mark.asyncio
async def test_openai_chat_uses_max_completion_tokens(monkeypatch):
    captured: list[dict] = []

    class _PatchedAsyncOpenAI(_FakeAsyncOpenAI):
        calls = captured

    monkeypatch.setattr("services.ai_provider.AsyncOpenAI", _PatchedAsyncOpenAI)

    provider = AIProvider(
        AIProviderConfig(
            provider="openai",
            model="gpt-5.4",
            api_key="sk-test",
        )
    )

    text, stop_reason, input_tokens, output_tokens = await provider._openai_compat_raw(
        "system",
        [{"role": "user", "content": "hello"}],
        base_url=None,
        api_key="sk-test",
        json_mode=False,
        temperature=0.3,
        max_tokens=64,
    )

    assert text == "OK"
    assert stop_reason == "stop"
    assert input_tokens == 3
    assert output_tokens == 2
    assert captured[0]["max_completion_tokens"] == 64
    assert "max_tokens" not in captured[0]


@pytest.mark.asyncio
async def test_gemini_openai_compat_keeps_max_tokens(monkeypatch):
    captured: list[dict] = []

    class _PatchedAsyncOpenAI(_FakeAsyncOpenAI):
        calls = captured

    monkeypatch.setattr("services.ai_provider.AsyncOpenAI", _PatchedAsyncOpenAI)

    provider = AIProvider(
        AIProviderConfig(
            provider="gemini",
            model="gemini-2.5-flash",
            api_key="AIza-test",
        )
    )

    await provider._openai_compat_raw(
        "system",
        [{"role": "user", "content": "hello"}],
        base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
        api_key="AIza-test",
        json_mode=False,
        temperature=0.3,
        max_tokens=64,
    )

    assert captured[0]["max_tokens"] == 64
    assert "max_completion_tokens" not in captured[0]
