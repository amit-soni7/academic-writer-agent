"""
ai_provider.py

Unified async LLM interface supporting:
  • OpenAI    — GPT-4o, GPT-4o-mini, GPT-4-turbo, GPT-3.5-turbo
  • Gemini    — gemini-2.5-flash, gemini-2.5-flash-lite, gemini-2.5-pro via OpenAI-compatible endpoint
  • Claude    — claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5 via Anthropic SDK
  • Ollama    — any locally-pulled model via Ollama's OpenAI-compatible endpoint
  • llama.cpp — any model loaded in llama-server via its OpenAI-compatible endpoint

All providers expose the same .complete(system, user, json_mode, temperature) → str
interface so the rest of the codebase doesn't care which backend is in use.

Truncation protection is provided transparently via CompletionGuard.  Every
.complete() call automatically detects stop_reason == "max_tokens", attempts one
continuation, and repairs broken JSON or prose before returning.  Use
.guarded_complete() for explicit control over continuations and token budgets.
"""

import logging

import anthropic
from openai import AsyncOpenAI

from models import AIProviderConfig
from services.completion_guard import (
    CompletionConfig,
    CompletionGuard,
    GuardedResponse,
    OutputFormat,
)

logger = logging.getLogger(__name__)

# Gemini exposes an OpenAI-compatible REST endpoint through AI Studio
GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"

# Models that only accept the API default temperature and reject custom values.
# Includes OpenAI o-series reasoning models and gpt-5+.
_NO_TEMPERATURE_PREFIXES = ("o1", "o2", "o3", "o4")
_NO_TEMPERATURE_EXACT = {"gpt-5"}


def _supports_temperature(model: str) -> bool:
    """Return False for models that reject a custom temperature parameter."""
    model_lower = model.lower()
    if model_lower in _NO_TEMPERATURE_EXACT:
        return False
    return not any(model_lower.startswith(p) for p in _NO_TEMPERATURE_PREFIXES)

_JSON_INSTRUCTION = (
    "IMPORTANT: You must respond with ONLY valid JSON. "
    "Do not include any explanation, markdown fences, or text outside the JSON object."
)


class AIProvider:
    """
    Single interface for all LLM backends.
    Instantiate with an AIProviderConfig and call .complete() anywhere.
    """

    def __init__(self, config: AIProviderConfig) -> None:
        self.config = config
        self.guard = CompletionGuard(self._raw_call)

    # ── Public API ──────────────────────────────────────────────────────────────

    async def complete(
        self,
        system: str,
        user: str,
        *,
        json_mode: bool = False,
        temperature: float = 0.3,
        max_tokens: int = 8192,
    ) -> str:
        """
        Send a system + user message and return the assistant's reply as a string.
        Set json_mode=True when the prompt explicitly requests JSON output.
        max_tokens: maximum output tokens (default 8192).

        Truncation is detected automatically.  If the response is cut off, one
        continuation is attempted and the result is repaired/stitched before
        returning.  Use guarded_complete() for more control.
        """
        config = CompletionConfig(
            output_format=OutputFormat.JSON if json_mode else OutputFormat.PROSE,
            explicit_max_tokens=max_tokens,
            max_continuations=1,
        )
        result = await self.guard.complete(
            system=system,
            messages=[{"role": "user", "content": user}],
            config=config,
            json_mode=json_mode,
            temperature=temperature,
        )
        return result.text

    async def guarded_complete(
        self,
        system: str,
        user: str,
        config: CompletionConfig,
        *,
        json_mode: bool = False,
        temperature: float = 0.3,
    ) -> GuardedResponse:
        """
        Like complete() but accepts an explicit CompletionConfig and returns a
        GuardedResponse with metadata (was_truncated, continuation_count, is_valid, …).

        Use this when you need fine-grained control over token budgets,
        continuation limits, or output validation.
        """
        return await self.guard.complete(
            system=system,
            messages=[{"role": "user", "content": user}],
            config=config,
            json_mode=json_mode,
            temperature=temperature,
        )

    async def test_connection(self) -> tuple[bool, str]:
        """Ping the provider with a trivial prompt. Returns (ok, message)."""
        try:
            reply = await self.complete(
                system="You are a helpful assistant.",
                user="Reply with exactly the word OK and nothing else.",
            )
            return True, reply.strip()
        except Exception as exc:
            return False, str(exc)

    # ── Low-level raw call (used by CompletionGuard) ────────────────────────────

    async def _raw_call(
        self,
        system: str,
        messages: list[dict],
        *,
        max_tokens: int = 8192,
        json_mode: bool = False,
        temperature: float = 0.3,
    ) -> tuple[str, str, int]:
        """
        Dispatch to the correct provider and return (text, stop_reason, tokens_used).

        stop_reason is normalised:
          "max_tokens" — the model was cut off (needs continuation)
          "stop"       — the model finished naturally
        """
        match self.config.provider:
            case "openai":
                return await self._openai_compat_raw(
                    system, messages,
                    base_url=None,
                    api_key=self.config.api_key,
                    json_mode=json_mode,
                    temperature=temperature,
                    max_tokens=max_tokens,
                )
            case "gemini":
                effective_key = self.config.gemini_oauth_access_token or self.config.api_key
                return await self._openai_compat_raw(
                    system, messages,
                    base_url=GEMINI_BASE_URL,
                    api_key=effective_key,
                    json_mode=json_mode,
                    temperature=temperature,
                    max_tokens=max_tokens,
                )
            case "claude":
                return await self._claude_raw(
                    system, messages,
                    json_mode=json_mode,
                    temperature=temperature,
                    max_tokens=max_tokens,
                )
            case "ollama":
                ollama_host = (self.config.base_url or "http://localhost:11434").rstrip("/")
                return await self._openai_compat_raw(
                    system, messages,
                    base_url=f"{ollama_host}/v1",
                    api_key="ollama",
                    json_mode=json_mode,
                    temperature=temperature,
                    max_tokens=max_tokens,
                )
            case "llamacpp":
                llamacpp_host = (self.config.base_url or "http://localhost:8080").rstrip("/")
                llamacpp_key = self.config.api_key or "llama-local"
                return await self._openai_compat_raw(
                    system, messages,
                    base_url=f"{llamacpp_host}/v1",
                    api_key=llamacpp_key,
                    json_mode=json_mode,
                    temperature=temperature,
                    max_tokens=max_tokens,
                )
            case _:
                raise ValueError(f"Unknown provider: {self.config.provider!r}")

    # ── OpenAI / Gemini / Ollama / llama.cpp (OpenAI-compatible REST API) ───────

    async def _openai_compat_raw(
        self,
        system: str,
        messages: list[dict],
        *,
        base_url: str | None,
        api_key: str,
        json_mode: bool,
        temperature: float,
        max_tokens: int,
    ) -> tuple[str, str, int]:
        """
        Make one call to an OpenAI-compatible endpoint.
        Returns (text, normalized_stop_reason, tokens_used).
        """
        client = AsyncOpenAI(api_key=api_key, base_url=base_url)
        full_messages = [{"role": "system", "content": system}] + messages
        kwargs: dict = dict(
            model=self.config.model,
            max_tokens=max_tokens,
            messages=full_messages,
        )
        if _supports_temperature(self.config.model):
            kwargs["temperature"] = temperature
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}

        response = await client.chat.completions.create(**kwargs)
        choice = response.choices[0]
        text = choice.message.content or ""
        finish_reason = choice.finish_reason or "stop"
        stop_reason = "max_tokens" if finish_reason == "length" else "stop"
        tokens_used = response.usage.completion_tokens if response.usage else 0
        return text, stop_reason, tokens_used

    # ── Claude (Anthropic SDK) ──────────────────────────────────────────────────

    async def _claude_raw(
        self,
        system: str,
        messages: list[dict],
        *,
        json_mode: bool,
        temperature: float,
        max_tokens: int,
    ) -> tuple[str, str, int]:
        """
        Make one call to the Anthropic Claude API.
        Returns (text, normalized_stop_reason, tokens_used).
        """
        client = anthropic.AsyncAnthropic(api_key=self.config.api_key)

        # Claude has no dedicated JSON mode; inject the instruction into the system prompt.
        effective_system = (f"{system}\n\n{_JSON_INSTRUCTION}" if json_mode else system)

        message = await client.messages.create(
            model=self.config.model,
            max_tokens=max_tokens,
            temperature=temperature,
            system=effective_system,
            messages=messages,
        )
        text = message.content[0].text if message.content else ""
        stop_reason = "max_tokens" if message.stop_reason == "max_tokens" else "stop"
        tokens_used = message.usage.output_tokens if message.usage else 0
        return text, stop_reason, tokens_used
