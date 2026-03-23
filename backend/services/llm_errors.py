"""
services/llm_errors.py

Typed exception hierarchy for LLM API errors.

Every exception stores the **raw error message** from the AI provider SDK
so that the exact text flows to the frontend unchanged.
"""


class LLMError(Exception):
    """Base for all LLM-related errors."""

    is_transient: bool = False

    def __init__(
        self,
        raw_message: str,
        *,
        provider: str = "",
        model: str = "",
        status_code: int | None = None,
        retry_after: float | None = None,
    ) -> None:
        super().__init__(raw_message)
        self.raw_message = raw_message
        self.provider = provider
        self.model = model
        self.status_code = status_code
        self.retry_after = retry_after

    @property
    def error_type(self) -> str:
        return "unknown"

    def to_dict(self) -> dict:
        return {
            "error_type": self.error_type,
            "message": self.raw_message,
            "provider": self.provider,
            "model": self.model,
            "status_code": self.status_code,
            "is_transient": self.is_transient,
            "retry_after": self.retry_after,
        }


class LLMRateLimitError(LLMError):
    """429 — rate limited (transient, retryable)."""
    is_transient = True

    @property
    def error_type(self) -> str:
        return "rate_limit"


class LLMQuotaExhaustedError(LLMError):
    """429 with quota/billing language — not transient."""
    is_transient = False

    @property
    def error_type(self) -> str:
        return "quota_exhausted"


class LLMAuthError(LLMError):
    """401/403 — bad or missing API key."""
    is_transient = False

    @property
    def error_type(self) -> str:
        return "auth"


class LLMBillingError(LLMError):
    """402 — payment required."""
    is_transient = False

    @property
    def error_type(self) -> str:
        return "billing"


class LLMServerError(LLMError):
    """500/502/503 — provider-side issue (transient)."""
    is_transient = True

    @property
    def error_type(self) -> str:
        return "server"


class LLMConnectionError(LLMError):
    """Network timeout or connection failure (transient)."""
    is_transient = True

    @property
    def error_type(self) -> str:
        return "connection"


class LLMBadRequestError(LLMError):
    """400 — context too long, invalid params, etc."""
    is_transient = False

    @property
    def error_type(self) -> str:
        return "bad_request"
