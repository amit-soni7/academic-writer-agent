from contextlib import asynccontextmanager
from pathlib import Path
import os

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).with_name(".env"))
except Exception:
    # Optional in case python-dotenv is not installed yet.
    pass

import secrets

from fastapi import FastAPI, Body, Cookie, Depends, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse

from routers import intent, journals, literature, projects, settings, usage
from services.llm_errors import (
    LLMAuthError,
    LLMBillingError,
    LLMError,
    LLMQuotaExhaustedError,
    LLMRateLimitError,
    LLMServerError,
)
from routers.sr_pipeline import router as sr_router
from services.db import init_db as init_db_pg
from services.auth import (
    login_with_google_code,
    build_google_login_url,
    get_current_user,
    AUTH_COOKIE_NAME,
    FRONTEND_BASE_URL,
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await init_db_pg()
    yield
    # Flush any pending token usage records on shutdown
    from services.token_tracker import flush_pending
    await flush_pending()

app = FastAPI(
    title="Academic Writer Agent",
    description="AI-powered backend for academic research, literature review, and manuscript drafting.",
    version="0.1.0",
    lifespan=lifespan,
)

# ── CORS ──────────────────────────────────────────────────────────────────────
def _cors_origins() -> list[str]:
    configured = os.getenv("CORS_ORIGINS", "").strip()
    if configured:
        return [origin.strip().rstrip("/") for origin in configured.split(",") if origin.strip()]
    return [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
    ]


app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routers ───────────────────────────────────────────────────────────────────
app.include_router(intent.router)
app.include_router(literature.router)
app.include_router(projects.router)
app.include_router(settings.router)
app.include_router(journals.router)
app.include_router(sr_router)
app.include_router(usage.router)


# ── Global LLM error handler ────────────────────────────────────────────────

_LLM_STATUS_MAP = {
    LLMRateLimitError: 429,
    LLMQuotaExhaustedError: 429,
    LLMAuthError: 401,
    LLMBillingError: 402,
    LLMServerError: 503,
}


@app.exception_handler(LLMError)
async def llm_error_handler(request: Request, exc: LLMError):
    status = _LLM_STATUS_MAP.get(type(exc), 500)
    return JSONResponse(status_code=status, content=exc.to_dict())


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Catch-all handler ensures CORS headers are always present on error responses.

    Without this, unhandled exceptions can bypass CORSMiddleware and the browser
    reports a misleading CORS error instead of the real server error.
    """
    import logging
    logging.getLogger("uvicorn.error").error(
        "Unhandled exception on %s %s: %s", request.method, request.url.path, exc, exc_info=True,
    )
    return JSONResponse(
        status_code=500,
        content={"detail": f"Internal server error: {type(exc).__name__}: {exc}"},
    )


@app.get("/health", tags=["meta"])
async def health_check():
    return {"status": "ok", "version": app.version}


# ── Auth routes ─────────────────────────────────────────────────────────────

@app.get("/api/auth/google/login", tags=["auth"])
async def auth_google_login():
    """Redirect to Google OAuth consent screen."""
    state = secrets.token_urlsafe(32)
    url = build_google_login_url(state)
    resp = RedirectResponse(url=url, status_code=302)
    resp.set_cookie(
        key="awa_oauth_state",
        value=state,
        httponly=True,
        secure=os.getenv("COOKIE_SECURE", "0") == "1",
        samesite="lax",
        max_age=600,
        path="/",
    )
    return resp


@app.get("/api/auth/google/callback", tags=["auth"])
async def auth_google_callback(
    code: str = Query(None),
    state: str = Query(None),
    error: str = Query(None),
    awa_oauth_state: str | None = Cookie(None),
):
    """Handle Google OAuth callback — exchange code, set session, redirect to frontend."""
    if error:
        return RedirectResponse(url=f"{FRONTEND_BASE_URL}/#/login?error={error}", status_code=302)
    if not state or not awa_oauth_state or state != awa_oauth_state:
        return RedirectResponse(url=f"{FRONTEND_BASE_URL}/#/login?error=csrf_failed", status_code=302)
    if not code:
        return RedirectResponse(url=f"{FRONTEND_BASE_URL}/#/login?error=no_code", status_code=302)
    try:
        token, _profile = await login_with_google_code(code)
    except Exception:
        return RedirectResponse(url=f"{FRONTEND_BASE_URL}/#/login?error=exchange_failed", status_code=302)
    resp = RedirectResponse(url=f"{FRONTEND_BASE_URL}/#/dashboard", status_code=302)
    resp.set_cookie(
        key=AUTH_COOKIE_NAME,
        value=token,
        httponly=True,
        secure=os.getenv("COOKIE_SECURE", "0") == "1",
        samesite=os.getenv("COOKIE_SAMESITE", "lax"),
        max_age=60 * 60 * 24 * 7,
        path="/",
    )
    resp.delete_cookie(key="awa_oauth_state", path="/")
    return resp


@app.get("/api/me", tags=["auth"])
async def whoami(user=Depends(get_current_user)):
    return user


@app.post("/api/logout", tags=["auth"])
async def logout(response: Response):
    response.delete_cookie(key=AUTH_COOKIE_NAME, path="/")
    return {"status": "ok"}
