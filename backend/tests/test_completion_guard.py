"""
test_completion_guard.py

Tests for the CompletionGuard anti-truncation system.
Covers TokenBudget, _repair_json, _ensure_sentence_complete,
and the full guard continuation + validation flow.
"""
import json
import pytest

from services.completion_guard import (
    CompletionConfig,
    CompletionGuard,
    GuardedResponse,
    OutputFormat,
    TokenBudget,
    _ends_mid_string,
    _ensure_sentence_complete,
    _repair_json,
)


# ── TokenBudget.calculate() ───────────────────────────────────────────────────

class TestTokenBudget:
    def test_target_words(self):
        budget = TokenBudget(target_words=1000)
        result = budget.calculate()
        # base = int(1000/0.75) = 1333, overhead = 200 (prose), * 1.4 = 2146
        assert 2000 <= result <= 2500

    def test_target_json_keys(self):
        budget = TokenBudget(target_json_keys=20, format=OutputFormat.JSON)
        result = budget.calculate()
        # base = 20*50 = 1000, overhead = 500 (JSON), * 1.4 = 2100
        assert 1800 <= result <= 2400

    def test_no_budget_returns_default(self):
        budget = TokenBudget()
        assert budget.calculate() == 8192

    def test_clamp_minimum(self):
        budget = TokenBudget(target_words=1)   # absurdly small
        assert budget.calculate() >= 1024

    def test_clamp_maximum(self):
        budget = TokenBudget(target_words=100_000)  # absurdly large
        assert budget.calculate() <= 16384

    def test_explicit_max_tokens_overrides_budget(self):
        config = CompletionConfig(
            budget=TokenBudget(target_words=500),
            explicit_max_tokens=999,
        )
        assert config.resolve_max_tokens() == 999

    def test_budget_overrides_default(self):
        config = CompletionConfig(budget=TokenBudget(target_words=500))
        result = config.resolve_max_tokens()
        assert result != 8192   # budget should differ from the plain default


# ── _ends_mid_string() ────────────────────────────────────────────────────────

class TestEndsMidString:
    def test_complete_strings_are_even(self):
        assert not _ends_mid_string('{"a": "hello"}')

    def test_open_string_is_odd(self):
        assert _ends_mid_string('{"a": "incomplete')

    def test_escaped_quote_not_counted(self):
        # The \" inside the value is escaped and must not count as a boundary
        assert not _ends_mid_string('{"a": "say \\"hi\\""}')

    def test_empty_string(self):
        assert not _ends_mid_string("")


# ── _repair_json() ────────────────────────────────────────────────────────────

class TestRepairJson:
    def test_already_valid(self):
        text = '{"a": 1, "b": "ok"}'
        assert json.loads(_repair_json(text)) == {"a": 1, "b": "ok"}

    def test_strip_markdown_fences(self):
        text = '```json\n{"a": 1}\n```'
        result = _repair_json(text)
        assert json.loads(result) == {"a": 1}

    def test_strip_plain_fences(self):
        text = '```\n{"a": 1}\n```'
        result = _repair_json(text)
        assert json.loads(result) == {"a": 1}

    def test_close_unclosed_array_and_object(self):
        text = '{"a": [1, 2, 3'
        result = _repair_json(text)
        parsed = json.loads(result)
        assert parsed["a"] == [1, 2, 3]

    def test_remove_incomplete_string_value(self):
        # "b" key has an incomplete string value — should be dropped
        text = '{"a": 1, "b": "incomplete'
        result = _repair_json(text)
        parsed = json.loads(result)
        assert parsed["a"] == 1
        assert "b" not in parsed or parsed.get("b") is None

    def test_remove_key_without_value(self):
        text = '{"a": 1, "b":'
        result = _repair_json(text)
        parsed = json.loads(result)
        assert parsed["a"] == 1
        assert "b" not in parsed

    def test_nested_object(self):
        text = '{"outer": {"inner": [1, 2'
        result = _repair_json(text)
        parsed = json.loads(result)
        assert parsed["outer"]["inner"] == [1, 2]


# ── _ensure_sentence_complete() ───────────────────────────────────────────────

class TestEnsureSentenceComplete:
    def test_already_complete(self):
        text = "This is complete."
        assert _ensure_sentence_complete(text) == "This is complete."

    def test_exclamation_mark(self):
        text = "Wow!"
        assert _ensure_sentence_complete(text) == "Wow!"

    def test_question_mark(self):
        text = "Really?"
        assert _ensure_sentence_complete(text) == "Really?"

    def test_truncated_mid_word(self):
        text = "First sentence. Second sentence is incompl"
        result = _ensure_sentence_complete(text)
        assert result == "First sentence."

    def test_no_sentence_boundary_adds_period(self):
        text = "No boundary at all whatsoever"
        result = _ensure_sentence_complete(text)
        assert result.endswith(".")

    def test_empty_string(self):
        assert _ensure_sentence_complete("") == ""

    def test_multiple_sentences_keeps_all_complete(self):
        text = "First. Second. Third incomplete"
        result = _ensure_sentence_complete(text)
        assert result == "First. Second."


# ── CompletionGuard — continuation flow ──────────────────────────────────────

class TestCompletionGuard:
    @pytest.mark.asyncio
    async def test_no_truncation_returns_immediately(self):
        async def raw_call(system, messages, *, max_tokens, **kwargs):
            return ("Hello world.", "stop", 10)

        guard = CompletionGuard(raw_call)
        result = await guard.complete(
            system="sys",
            messages=[{"role": "user", "content": "hi"}],
            config=CompletionConfig(output_format=OutputFormat.PROSE),
        )
        assert "Hello world" in result.text
        assert not result.was_truncated
        assert result.continuation_count == 0

    @pytest.mark.asyncio
    async def test_truncation_triggers_continuation(self):
        call_count = 0

        async def raw_call(system, messages, *, max_tokens, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return ("First part", "max_tokens", 20)
            return (" second part.", "stop", 15)

        guard = CompletionGuard(raw_call)
        result = await guard.complete(
            system="sys",
            messages=[{"role": "user", "content": "hi"}],
            config=CompletionConfig(
                output_format=OutputFormat.PROSE,
                max_continuations=2,
            ),
        )
        assert result.was_truncated
        assert result.continuation_count == 1
        assert "First part" in result.text
        assert "second part" in result.text
        assert result.total_tokens_used == 35

    @pytest.mark.asyncio
    async def test_max_continuations_respected(self):
        async def raw_call(system, messages, *, max_tokens, **kwargs):
            return ("partial", "max_tokens", 10)

        guard = CompletionGuard(raw_call)
        result = await guard.complete(
            system="sys",
            messages=[{"role": "user", "content": "hi"}],
            config=CompletionConfig(
                output_format=OutputFormat.PROSE,
                max_continuations=2,
            ),
        )
        # Should stop after max_continuations (2) attempts, so 3 total calls
        assert result.was_truncated
        assert result.continuation_count == 2

    @pytest.mark.asyncio
    async def test_json_mode_returns_valid_json(self):
        async def raw_call(system, messages, *, max_tokens, **kwargs):
            return ('{"a": 1, "b": 2}', "stop", 20)

        guard = CompletionGuard(raw_call)
        result = await guard.complete(
            system="sys",
            messages=[{"role": "user", "content": "give me json"}],
            config=CompletionConfig(output_format=OutputFormat.JSON),
        )
        assert result.is_valid
        parsed = json.loads(result.text)
        assert parsed["a"] == 1

    @pytest.mark.asyncio
    async def test_json_repair_on_truncated_json(self):
        async def raw_call(system, messages, *, max_tokens, **kwargs):
            # First call: truncated JSON; second call: rest (for continuation)
            if len(messages) == 1:
                return ('{"a": 1, "b": [1, 2', "max_tokens", 20)
            return (", 3]}", "stop", 10)

        guard = CompletionGuard(raw_call)
        result = await guard.complete(
            system="sys",
            messages=[{"role": "user", "content": "json please"}],
            config=CompletionConfig(
                output_format=OutputFormat.JSON,
                max_continuations=1,
            ),
        )
        # After stitching: '{"a": 1, "b": [1, 2, 3]}'
        assert result.is_valid
        parsed = json.loads(result.text)
        assert parsed["a"] == 1
        assert parsed["b"] == [1, 2, 3]

    @pytest.mark.asyncio
    async def test_hint_appended_to_user_message(self):
        seen_messages = []

        async def raw_call(system, messages, *, max_tokens, **kwargs):
            seen_messages.extend(messages)
            return ("done.", "stop", 5)

        guard = CompletionGuard(raw_call)
        await guard.complete(
            system="sys",
            messages=[{"role": "user", "content": "original"}],
            config=CompletionConfig(output_format=OutputFormat.PROSE),
        )
        user_msg = seen_messages[-1]["content"]
        assert "original" in user_msg
        assert "Complete every sentence" in user_msg  # prose hint
