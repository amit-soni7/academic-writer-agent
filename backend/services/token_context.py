"""
services/token_context.py

Async context manager that propagates project_id, user_id, and stage
into the AIProvider token tracking layer via contextvars.

Usage in routers:
    async with TokenContext(project_id=pid, user_id=uid, stage="write_article"):
        result = await provider.complete(...)
"""

import contextvars

_project_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("token_project_id", default=None)
_user_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("token_user_id", default=None)
_stage: contextvars.ContextVar[str | None] = contextvars.ContextVar("token_stage", default=None)


class TokenContext:
    """Async context manager that sets project/user/stage for token tracking."""

    def __init__(
        self,
        *,
        project_id: str | None = None,
        user_id: str | None = None,
        stage: str | None = None,
    ) -> None:
        self.project_id = project_id
        self.user_id = user_id
        self.stage = stage

    async def __aenter__(self):
        self._t1 = _project_id.set(self.project_id)
        self._t2 = _user_id.set(self.user_id)
        self._t3 = _stage.set(self.stage)
        return self

    async def __aexit__(self, *args):
        _project_id.reset(self._t1)
        _user_id.reset(self._t2)
        _stage.reset(self._t3)


def get_current_context() -> dict[str, str | None]:
    """Return the current token tracking context."""
    return {
        "project_id": _project_id.get(),
        "user_id": _user_id.get(),
        "stage": _stage.get(),
    }
