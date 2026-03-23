"""
completion_guard.py

Anti-truncation middleware for LLM completions.

Wraps any async LLM raw-call function to:
  1. Calculate token budgets dynamically instead of hardcoding.
  2. Detect truncation via the provider's stop_reason.
  3. Attempt continuation if truncated (up to max_continuations times).
  4. Repair / validate JSON output.
  5. Ensure prose ends at a sentence boundary.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from enum import Enum
from typing import Callable, Optional

logger = logging.getLogger(__name__)


# ── Enums & dataclasses ───────────────────────────────────────────────────────

class OutputFormat(Enum):
    JSON = "json"
    PROSE = "prose"
    MARKDOWN = "markdown"


@dataclass
class TokenBudget:
    """
    Calculates max_tokens dynamically based on expected output size.

    Usage examples:
      TokenBudget(target_words=1200)            # prose section ~1200 words
      TokenBudget(target_json_keys=30)          # JSON with ~30 key-value pairs
      TokenBudget()                             # no budget → returns 8192 default
    """
    target_words: Optional[int] = None
    target_json_keys: Optional[int] = None
    format: OutputFormat = OutputFormat.PROSE
    safety_margin: float = 1.4

    def calculate(self) -> int:
        if self.target_words is not None:
            base = int(self.target_words / 0.75)  # 1 token ≈ 0.75 English words
        elif self.target_json_keys is not None:
            base = self.target_json_keys * 50     # avg tokens per key-value pair
        else:
            return 8192  # no budget hint → use global default

        overhead = 500 if self.format == OutputFormat.JSON else 200
        result = int((base + overhead) * self.safety_margin)
        return max(1024, min(16384, result))


@dataclass
class CompletionConfig:
    """Configuration for a single guarded LLM call."""
    output_format: OutputFormat = OutputFormat.PROSE
    max_continuations: int = 2
    budget: Optional[TokenBudget] = None
    explicit_max_tokens: Optional[int] = None
    validator: Optional[Callable[[str], bool]] = None

    def resolve_max_tokens(self) -> int:
        if self.explicit_max_tokens is not None:
            return self.explicit_max_tokens
        if self.budget is not None:
            return self.budget.calculate()
        return 8192


@dataclass
class GuardedResponse:
    """Result returned by CompletionGuard.complete()."""
    text: str
    was_truncated: bool = False
    continuation_count: int = 0
    total_tokens_used: int = 0
    total_input_tokens: int = 0
    is_valid: bool = True
    validation_error: Optional[str] = None


# ── Post-processing helpers ───────────────────────────────────────────────────

def _ends_mid_string(text: str) -> bool:
    """Return True if text ends inside an open JSON string (unescaped quote count is odd)."""
    count = 0
    i = 0
    while i < len(text):
        if text[i] == "\\" and i + 1 < len(text):
            i += 2  # skip the escaped character
        elif text[i] == '"':
            count += 1
            i += 1
        else:
            i += 1
    return count % 2 != 0


def _repair_json(text: str) -> str:
    """
    Attempt to repair truncated JSON.

    Steps:
      1. Strip markdown code fences.
      2. If already valid, return immediately.
      3. Iteratively remove trailing incomplete key-value pairs and close
         unclosed braces/brackets until json.loads succeeds (up to 8 tries).
      4. Return repaired text, or the original if all repairs fail.
    """
    # Strip markdown code fences (```json ... ``` or ``` ... ```)
    text = re.sub(r"^```(?:json)?\s*\n?", "", text.strip())
    text = re.sub(r"\n?```$", "", text.strip())
    text = text.strip()

    # Already valid — nothing to do
    try:
        json.loads(text)
        return text
    except json.JSONDecodeError:
        pass

    working = text
    for _ in range(8):
        trimmed = working.rstrip().rstrip(",").rstrip()

        # If we're mid-string, find the last separator before the open string
        if _ends_mid_string(trimmed):
            last_sep = max(trimmed.rfind(","), trimmed.rfind(":"))
            if last_sep > 0:
                trimmed = trimmed[:last_sep].rstrip().rstrip(",").rstrip()

        # Recount open structures after any trimming
        open_braces = trimmed.count("{") - trimmed.count("}")
        open_brackets = trimmed.count("[") - trimmed.count("]")
        closing = "]" * max(0, open_brackets) + "}" * max(0, open_braces)
        candidate = trimmed + closing

        try:
            json.loads(candidate)
            return candidate
        except json.JSONDecodeError:
            # Remove back to the last comma and retry
            last_comma = working.rfind(",")
            if last_comma > 0:
                working = working[:last_comma]
            else:
                break

    return text  # return original if all repairs fail


def _ensure_sentence_complete(text: str) -> str:
    """
    Truncate prose to the last complete sentence if it ends mid-sentence.
    If no sentence boundary is found, append a period.
    """
    text = text.rstrip()
    if not text:
        return text

    # Already ends at a sentence boundary
    if text[-1] in ".!?":
        return text

    # Find last sentence-ending punctuation followed by whitespace or end-of-string
    matches = list(re.finditer(r"[.!?](?=\s|$)", text))
    if matches:
        last = matches[-1]
        return text[: last.start() + 1]

    # No boundary found — close the thought with a period
    return text + "."


# ── Completion hints injected into the last user message ─────────────────────

_COMPLETION_HINTS: dict[OutputFormat, str] = {
    OutputFormat.JSON: (
        "Return valid, complete JSON. "
        "Prioritize closing all braces/brackets over adding detail."
    ),
    OutputFormat.PROSE: (
        "Complete every sentence. "
        "If approaching length limit, write a brief conclusion rather than stopping mid-sentence."
    ),
    OutputFormat.MARKDOWN: (
        "Complete every section. "
        "Close the current section rather than stopping mid-sentence."
    ),
}


# ── Core guard ────────────────────────────────────────────────────────────────

class CompletionGuard:
    """
    Wraps an async LLM raw-call function to detect and handle truncation.

    The injected raw_call must have this signature:

        async def raw_call(
            system: str,
            messages: list[dict],
            *,
            max_tokens: int,
            **kwargs,          # json_mode, temperature, etc.
        ) -> tuple[str, str, int, int]:
            ...
            # Returns: (text, normalized_stop_reason, input_tokens, output_tokens)
            # normalized_stop_reason: "max_tokens" = truncated, anything else = complete.

    Usage:
        guard = CompletionGuard(provider._raw_call)
        result = await guard.complete(system, messages, config, json_mode=True, temperature=0.2)
    """

    def __init__(self, raw_call) -> None:
        self.raw_call = raw_call

    async def complete(
        self,
        system: str,
        messages: list[dict],
        config: CompletionConfig,
        **kwargs,
    ) -> GuardedResponse:
        """
        Make a guarded LLM call with truncation detection and optional continuation.

        kwargs are forwarded verbatim to raw_call (e.g. json_mode, temperature).
        max_tokens is derived from config, not passed as a kwarg.
        """
        max_tokens = config.resolve_max_tokens()
        accumulated_text = ""
        was_truncated = False
        continuation_count = 0
        total_tokens = 0
        total_input = 0

        # Append a format-appropriate completion hint to the last user message
        hint = _COMPLETION_HINTS[config.output_format]
        working_messages = list(messages)
        if working_messages and working_messages[-1]["role"] == "user":
            last = working_messages[-1]
            working_messages = working_messages[:-1] + [
                {**last, "content": f"{last['content']}\n\n{hint}"}
            ]

        while True:
            raw_result = await self.raw_call(
                system=system,
                messages=working_messages,
                max_tokens=max_tokens,
                **kwargs,
            )
            # Support both 3-tuple (legacy) and 4-tuple (with input tokens)
            if len(raw_result) == 4:
                text, stop_reason, input_tokens, tokens_used = raw_result
                total_input += input_tokens
            else:
                text, stop_reason, tokens_used = raw_result
            total_tokens += tokens_used
            accumulated_text += text
            truncated = stop_reason == "max_tokens"

            if not truncated:
                break

            was_truncated = True
            if continuation_count >= config.max_continuations:
                logger.error(
                    "CompletionGuard: max continuations (%d) reached, output may be incomplete",
                    config.max_continuations,
                )
                break

            logger.warning(
                "CompletionGuard: truncation detected (continuation %d/%d)",
                continuation_count + 1,
                config.max_continuations,
            )
            working_messages = working_messages + [
                {"role": "assistant", "content": accumulated_text},
                {
                    "role": "user",
                    "content": (
                        "Your previous response was cut off. Continue EXACTLY from where you "
                        "stopped. Do not repeat any content."
                    ),
                },
            ]
            continuation_count += 1

        # Post-process accumulated output
        final_text = accumulated_text
        if config.output_format == OutputFormat.JSON:
            final_text = _repair_json(final_text)
        elif was_truncated:
            # PROSE and MARKDOWN: ensure clean sentence boundary
            final_text = _ensure_sentence_complete(final_text)

        # Validate
        is_valid = True
        validation_error = None
        if config.output_format == OutputFormat.JSON:
            try:
                json.loads(final_text)
            except json.JSONDecodeError as e:
                is_valid = False
                validation_error = f"JSON repair failed: {e}"
                logger.error("CompletionGuard: JSON validation failed: %s", e)

        if config.validator and is_valid:
            try:
                if not config.validator(final_text):
                    is_valid = False
                    validation_error = "Custom validator returned False"
            except Exception as e:
                is_valid = False
                validation_error = str(e)
                logger.error("CompletionGuard: custom validator raised: %s", e)

        return GuardedResponse(
            text=final_text,
            was_truncated=was_truncated,
            continuation_count=continuation_count,
            total_tokens_used=total_tokens,
            total_input_tokens=total_input,
            is_valid=is_valid,
            validation_error=validation_error,
        )
