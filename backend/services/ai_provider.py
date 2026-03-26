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

import asyncio
import json
import logging

import anthropic
import httpx
import openai
from openai import AsyncOpenAI

from models import AIProviderConfig
from services.provider_config import get_model_meta
from services.completion_guard import (
    CompletionConfig,
    CompletionGuard,
    GuardedResponse,
    OutputFormat,
)
from services.token_context import get_current_context
from services.token_tracker import record_usage
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

logger = logging.getLogger(__name__)

# ── Retry settings ─────────────────────────────────────────────────────────────
_MAX_RETRIES = 3
_BACKOFF_BASE = 3.0       # seconds
_BACKOFF_CAP = 120.0      # seconds

# Gemini exposes an OpenAI-compatible REST endpoint through AI Studio
GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
GEMINI_NATIVE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

# Models that only accept the API default temperature and reject custom values.
# Includes OpenAI o-series reasoning models and the entire gpt-5 family.
_NO_TEMPERATURE_PREFIXES = ("o1", "o2", "o3", "o4", "gpt-5")


def _supports_temperature(model: str) -> bool:
    """Return False for models that reject a custom temperature parameter."""
    model_lower = model.lower()
    return not any(model_lower.startswith(p) for p in _NO_TEMPERATURE_PREFIXES)


def _openai_chat_token_budget_param(provider: str) -> str:
    """
    OpenAI's Chat Completions API has moved to max_completion_tokens, while
    other OpenAI-compatible endpoints in this app still expect max_tokens.
    """
    return "max_completion_tokens" if provider.lower() == "openai" else "max_tokens"

_JSON_INSTRUCTION = (
    "IMPORTANT: You must respond with ONLY valid JSON. "
    "Do not include any explanation, markdown fences, or text outside the JSON object."
)


def _coerce_text_content(value) -> str:
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=True)
    return str(value)


def _extract_google_error_message(payload: dict, fallback: str) -> str:
    if isinstance(payload, dict):
        err = payload.get("error")
        if isinstance(err, dict):
            return str(err.get("message") or fallback)
    return fallback


class AIProvider:
    """
    Single interface for all LLM backends.
    Instantiate with an AIProviderConfig and call .complete() anywhere.
    """

    def __init__(self, config: AIProviderConfig) -> None:
        self.config = config
        self.model_meta = get_model_meta(config.provider, config.model)
        self.guard = CompletionGuard(self._retry_raw_call)
        self.last_auth_source: str | None = None

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
        self._record_tokens(result)
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
        result = await self.guard.complete(
            system=system,
            messages=[{"role": "user", "content": user}],
            config=config,
            json_mode=json_mode,
            temperature=temperature,
        )
        self._record_tokens(result)
        return result

    async def test_connection(self) -> tuple[bool, str]:
        """Ping the provider with a trivial prompt. Returns (ok, message)."""
        self.last_auth_source = None
        try:
            reply = await self.complete(
                system="You are a helpful assistant.",
                user="Reply with exactly the word OK and nothing else.",
            )
            return True, reply.strip()
        except Exception as exc:
            return False, str(exc)

    # ── Token recording ────────────────────────────────────────────────────────

    def _record_tokens(self, result: GuardedResponse) -> None:
        """Fire-and-forget record token usage from a guarded response."""
        if result.total_input_tokens == 0 and result.total_tokens_used == 0:
            return
        ctx = get_current_context()
        try:
            asyncio.create_task(record_usage(
                provider=self.config.provider,
                model=self.config.model,
                input_tokens=result.total_input_tokens,
                output_tokens=result.total_tokens_used,
                project_id=ctx.get("project_id"),
                user_id=ctx.get("user_id"),
                stage=ctx.get("stage"),
            ))
        except RuntimeError:
            pass  # no event loop (e.g. during shutdown)

    # ── Retry wrapper ──────────────────────────────────────────────────────────

    async def _retry_raw_call(
        self,
        system: str,
        messages: list[dict],
        *,
        max_tokens: int = 8192,
        json_mode: bool = False,
        temperature: float = 0.3,
    ) -> tuple[str, str, int]:
        """Wrap _raw_call with exponential-backoff retry for transient errors."""
        last_error: LLMError | None = None
        for attempt in range(_MAX_RETRIES + 1):
            try:
                return await self._raw_call(
                    system, messages,
                    max_tokens=max_tokens,
                    json_mode=json_mode,
                    temperature=temperature,
                )
            except LLMError as e:
                last_error = e
                if not e.is_transient or attempt == _MAX_RETRIES:
                    raise
                delay = min(
                    e.retry_after or (_BACKOFF_BASE * (2 ** attempt)),
                    _BACKOFF_CAP,
                )
                logger.warning(
                    "LLM %s (attempt %d/%d) — retrying in %.1fs: %s",
                    e.error_type, attempt + 1, _MAX_RETRIES,
                    delay, e.raw_message[:200],
                )
                await asyncio.sleep(delay)

        # Should not reach here, but just in case
        raise last_error  # type: ignore[misc]

    # ── Low-level raw call (used by retry wrapper) ────────────────────────────

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
                if (self.config.auth_method or "api_key").lower() == "oauth":
                    return await self._gemini_oauth_with_fallback_raw(
                        system,
                        messages,
                        json_mode=json_mode,
                        temperature=temperature,
                        max_tokens=max_tokens,
                    )
                self.last_auth_source = "api_key"
                return await self._openai_compat_raw(
                    system, messages,
                    base_url=GEMINI_BASE_URL,
                    api_key=self.config.api_key,
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
            messages=full_messages,
        )
        kwargs[_openai_chat_token_budget_param(self.config.provider)] = max_tokens
        if _supports_temperature(self.config.model):
            kwargs["temperature"] = temperature
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}

        try:
            response = await client.chat.completions.create(**kwargs)
        except openai.RateLimitError as e:
            raise self._classify_openai_status(e, 429)
        except openai.AuthenticationError as e:
            raise LLMAuthError(
                str(e), provider=self.config.provider,
                model=self.config.model, status_code=401,
            ) from e
        except openai.APIStatusError as e:
            raise self._classify_openai_status(e, e.status_code) from e
        except (openai.APIConnectionError, openai.APITimeoutError) as e:
            raise LLMConnectionError(
                str(e), provider=self.config.provider,
                model=self.config.model,
            ) from e

        choice = response.choices[0]
        text = choice.message.content or ""
        finish_reason = choice.finish_reason or "stop"
        stop_reason = "max_tokens" if finish_reason == "length" else "stop"
        input_tokens = response.usage.prompt_tokens if response.usage else 0
        output_tokens = response.usage.completion_tokens if response.usage else 0
        return text, stop_reason, input_tokens, output_tokens

    def _classify_openai_status(self, exc: Exception, status_code: int) -> LLMError:
        """Map an OpenAI-SDK exception to the appropriate LLMError subclass."""
        msg = str(exc)
        kw = dict(provider=self.config.provider, model=self.config.model, status_code=status_code)
        # Extract retry-after if available
        retry_after = None
        if hasattr(exc, "response") and hasattr(exc.response, "headers"):
            ra = exc.response.headers.get("retry-after")
            if ra:
                try:
                    retry_after = float(ra)
                except ValueError:
                    pass

        if status_code == 429:
            low = msg.lower()
            if "quota" in low or "billing" in low or "exceeded" in low:
                return LLMQuotaExhaustedError(msg, retry_after=retry_after, **kw)
            return LLMRateLimitError(msg, retry_after=retry_after, **kw)
        if status_code in (401, 403):
            return LLMAuthError(msg, **kw)
        if status_code == 402:
            return LLMBillingError(msg, **kw)
        if status_code in (500, 502, 503):
            return LLMServerError(msg, retry_after=retry_after, **kw)
        if status_code == 400:
            return LLMBadRequestError(msg, **kw)
        return LLMError(msg, **kw)

    async def _gemini_oauth_with_fallback_raw(
        self,
        system: str,
        messages: list[dict],
        *,
        json_mode: bool,
        temperature: float,
        max_tokens: int,
    ) -> tuple[str, str, int]:
        try:
            return await self._gemini_native_raw(
                system,
                messages,
                json_mode=json_mode,
                temperature=temperature,
                max_tokens=max_tokens,
            )
        except LLMAuthError as exc:
            if not self.config.api_key:
                raise
            logger.warning(
                "Gemini OAuth failed for model %s; retrying with saved API key fallback: %s",
                self.config.model,
                exc.raw_message[:200],
            )
            self.last_auth_source = "api_key_fallback"
            return await self._openai_compat_raw(
                system,
                messages,
                base_url=GEMINI_BASE_URL,
                api_key=self.config.api_key,
                json_mode=json_mode,
                temperature=temperature,
                max_tokens=max_tokens,
            )

    async def _gemini_native_raw(
        self,
        system: str,
        messages: list[dict],
        *,
        json_mode: bool,
        temperature: float,
        max_tokens: int,
    ) -> tuple[str, str, int]:
        access_token = self.config.gemini_oauth_access_token or ""
        project_id = self.config.gemini_cloud_project_id or ""
        if not access_token:
            raise LLMAuthError(
                "Gemini OAuth is selected, but no valid OAuth access token is available.",
                provider="gemini",
                model=self.config.model,
                status_code=401,
            )
        if not project_id:
            raise LLMAuthError(
                "Gemini OAuth requires GOOGLE_CLOUD_PROJECT_ID to be configured on the server.",
                provider="gemini",
                model=self.config.model,
                status_code=401,
            )

        generation_config: dict = {"maxOutputTokens": max_tokens}
        if _supports_temperature(self.config.model):
            generation_config["temperature"] = temperature
        if json_mode:
            generation_config["responseMimeType"] = "application/json"

        payload = {
            "contents": [
                {
                    "role": "model" if msg.get("role") == "assistant" else "user",
                    "parts": [{"text": _coerce_text_content(msg.get("content"))}],
                }
                for msg in messages
            ],
            "generationConfig": generation_config,
        }
        if system:
            payload["systemInstruction"] = {"parts": [{"text": system}]}

        headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
            "x-goog-user-project": project_id,
        }

        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                response = await client.post(
                    f"{GEMINI_NATIVE_BASE_URL}/models/{self.config.model}:generateContent",
                    headers=headers,
                    json=payload,
                )
        except httpx.TimeoutException as exc:
            raise LLMConnectionError(
                str(exc),
                provider="gemini",
                model=self.config.model,
            ) from exc
        except httpx.HTTPError as exc:
            raise LLMConnectionError(
                str(exc),
                provider="gemini",
                model=self.config.model,
            ) from exc

        if response.status_code >= 400:
            retry_after = None
            ra = response.headers.get("retry-after")
            if ra:
                try:
                    retry_after = float(ra)
                except ValueError:
                    retry_after = None
            try:
                payload = response.json()
            except ValueError:
                payload = {}
            message = _extract_google_error_message(payload, response.text or "Gemini request failed.")
            if response.status_code == 429:
                low = message.lower()
                if "quota" in low or "billing" in low or "exceeded" in low:
                    raise LLMQuotaExhaustedError(
                        message,
                        provider="gemini",
                        model=self.config.model,
                        status_code=429,
                        retry_after=retry_after,
                    )
                raise LLMRateLimitError(
                    message,
                    provider="gemini",
                    model=self.config.model,
                    status_code=429,
                    retry_after=retry_after,
                )
            if response.status_code in (401, 403):
                raise LLMAuthError(
                    message,
                    provider="gemini",
                    model=self.config.model,
                    status_code=response.status_code,
                )
            if response.status_code == 402:
                raise LLMBillingError(
                    message,
                    provider="gemini",
                    model=self.config.model,
                    status_code=402,
                )
            if response.status_code in (500, 502, 503):
                raise LLMServerError(
                    message,
                    provider="gemini",
                    model=self.config.model,
                    status_code=response.status_code,
                    retry_after=retry_after,
                )
            if response.status_code == 400:
                raise LLMBadRequestError(
                    message,
                    provider="gemini",
                    model=self.config.model,
                    status_code=400,
                )
            raise LLMError(
                message,
                provider="gemini",
                model=self.config.model,
                status_code=response.status_code,
                retry_after=retry_after,
            )

        data = response.json()
        candidates = data.get("candidates") or []
        parts = ((candidates[0] or {}).get("content") or {}).get("parts") if candidates else []
        text = "".join(str(part.get("text") or "") for part in parts if isinstance(part, dict))
        finish_reason = str((candidates[0] or {}).get("finishReason") or "STOP").upper() if candidates else "STOP"
        stop_reason = "max_tokens" if finish_reason == "MAX_TOKENS" else "stop"
        usage = data.get("usageMetadata") or {}
        input_tokens = int(usage.get("promptTokenCount") or 0)
        output_tokens = int(usage.get("candidatesTokenCount") or 0)
        self.last_auth_source = "oauth"
        return text, stop_reason, input_tokens, output_tokens

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
        key = self.config.api_key
        if key.startswith("sk-ant-oat01-"):
            client = anthropic.AsyncAnthropic(
                auth_token=key,
                default_headers={
                    "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14",
                    "user-agent": "claude-cli/2.1.2 (external, cli)",
                    "x-app": "cli",
                },
            )
        else:
            client = anthropic.AsyncAnthropic(api_key=key)

        # Claude has no dedicated JSON mode; inject the instruction into the system prompt.
        effective_system = (f"{system}\n\n{_JSON_INSTRUCTION}" if json_mode else system)

        try:
            message = await client.messages.create(
                model=self.config.model,
                max_tokens=max_tokens,
                temperature=temperature,
                system=effective_system,
                messages=messages,
            )
        except anthropic.RateLimitError as e:
            kw = dict(provider="claude", model=self.config.model, status_code=429)
            low = str(e).lower()
            if "quota" in low or "billing" in low:
                raise LLMQuotaExhaustedError(str(e), **kw) from e
            raise LLMRateLimitError(str(e), **kw) from e
        except anthropic.AuthenticationError as e:
            raise LLMAuthError(
                str(e), provider="claude", model=self.config.model, status_code=401,
            ) from e
        except anthropic.APIStatusError as e:
            status = getattr(e, "status_code", 500)
            kw = dict(provider="claude", model=self.config.model, status_code=status)
            if status == 402:
                raise LLMBillingError(str(e), **kw) from e
            if status in (500, 502, 503):
                raise LLMServerError(str(e), **kw) from e
            if status == 400:
                raise LLMBadRequestError(str(e), **kw) from e
            raise LLMError(str(e), **kw) from e
        except (anthropic.APIConnectionError, anthropic.APITimeoutError) as e:
            raise LLMConnectionError(
                str(e), provider="claude", model=self.config.model,
            ) from e

        text = message.content[0].text if message.content else ""
        stop_reason = "max_tokens" if message.stop_reason == "max_tokens" else "stop"
        input_tokens = message.usage.input_tokens if message.usage else 0
        output_tokens = message.usage.output_tokens if message.usage else 0
        return text, stop_reason, input_tokens, output_tokens

    # ── Context-cached completion (all providers) ────────────────────────────

    async def complete_cached(
        self,
        cacheable_context: str,
        system: str,
        user: str,
        *,
        json_mode: bool = False,
        temperature: float = 0.3,
        max_tokens: int = 8192,
        gemini_cache_name: str = "",
    ) -> str:
        """
        Complete with a large cacheable context (e.g. a manuscript) that stays
        constant across multiple calls, plus a per-call system prompt and user message.

        Provider behaviour:
        - OpenAI / Ollama / llama.cpp: cacheable_context prepended to system prompt.
          OpenAI auto-caches identical prefixes at 50% discount.
        - Claude: cacheable_context sent as a separate system block with
          cache_control: {"type": "ephemeral"} for 90% input token discount.
        - Gemini: if gemini_cache_name is provided, uses the native CachedContent
          API. Otherwise falls back to the OpenAI-compat path.
        """
        if self.config.provider == "claude":
            return await self._claude_cached_call(
                cacheable_context=cacheable_context,
                system=system,
                user=user,
                json_mode=json_mode,
                temperature=temperature,
                max_tokens=max_tokens,
            )

        if self.config.provider == "gemini" and gemini_cache_name and self.config.api_key:
            try:
                return await self._gemini_cached_call(
                    cache_name=gemini_cache_name,
                    system=system,
                    user=user,
                    json_mode=json_mode,
                    temperature=temperature,
                    max_tokens=max_tokens,
                )
            except Exception:
                pass  # fall through to openai-compat path

        # OpenAI / Gemini (no cache) / Ollama / llama.cpp:
        # Prepend cacheable_context to system prompt — OpenAI auto-caches the prefix.
        combined_system = f"{cacheable_context}\n\n{system}"
        return await self.complete(
            system=combined_system,
            user=user,
            json_mode=json_mode,
            temperature=temperature,
            max_tokens=max_tokens,
        )

    async def _claude_cached_call(
        self,
        cacheable_context: str,
        system: str,
        user: str,
        *,
        json_mode: bool,
        temperature: float,
        max_tokens: int,
    ) -> str:
        """Claude call with cache_control on the cacheable context block."""
        key = self.config.api_key
        if key.startswith("sk-ant-oat01-"):
            client = anthropic.AsyncAnthropic(
                auth_token=key,
                default_headers={
                    "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14",
                    "user-agent": "claude-cli/2.1.2 (external, cli)",
                    "x-app": "cli",
                },
            )
        else:
            client = anthropic.AsyncAnthropic(api_key=key)

        per_call_system = (f"{system}\n\n{_JSON_INSTRUCTION}" if json_mode else system)

        system_blocks = [
            {"type": "text", "text": cacheable_context, "cache_control": {"type": "ephemeral"}},
            {"type": "text", "text": per_call_system},
        ]

        message = await client.messages.create(
            model=self.config.model,
            max_tokens=max_tokens,
            temperature=temperature,
            system=system_blocks,
            messages=[{"role": "user", "content": user}],
        )
        return message.content[0].text if message.content else ""

    async def _gemini_cached_call(
        self,
        cache_name: str,
        system: str,
        user: str,
        *,
        json_mode: bool,
        temperature: float,
        max_tokens: int,
    ) -> str:
        """Gemini call using a pre-created CachedContent."""
        from google import genai

        self.last_auth_source = "api_key"
        client = genai.Client(api_key=self.config.api_key)
        full_user = f"{system}\n\n{user}" if system else user
        response = await client.aio.models.generate_content(
            model=self.config.model,
            contents=full_user,
            config={
                "cached_content": cache_name,
                "temperature": temperature,
                "max_output_tokens": max_tokens,
            },
        )
        return response.text or ""

    async def create_gemini_cache(
        self,
        system: str,
        content: str,
        ttl_seconds: int = 7200,
    ) -> str | None:
        """Create a Gemini cached context. Returns cache name or None for non-Gemini."""
        if self.config.provider != "gemini":
            return None
        if not self.config.api_key:
            logger.info(
                "Skipping Gemini cache creation for model %s because no Gemini API key is saved.",
                self.config.model,
            )
            return None
        try:
            from google import genai

            self.last_auth_source = "api_key"
            client = genai.Client(api_key=self.config.api_key)
            cache = client.caches.create(
                model=self.config.model,
                config={
                    "system_instruction": system,
                    "contents": [{"role": "user", "parts": [{"text": content}]}],
                    "ttl": f"{ttl_seconds}s",
                },
            )
            return cache.name
        except Exception as exc:
            logger.warning("Gemini cache creation failed: %s", exc)
            return None
