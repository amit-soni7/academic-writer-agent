"""
routers/usage.py

API endpoints for querying AI token usage and cost data.
"""

from fastapi import APIRouter, Depends, Query

from services.auth import get_current_user
from services.token_tracker import (
    get_all_projects_usage,
    get_project_usage,
    get_project_usage_by_stage,
    get_user_daily_usage,
    get_user_usage,
    get_user_usage_by_provider,
    get_user_usage_by_stage,
)

router = APIRouter(prefix="/api/usage", tags=["usage"])


@router.get("")
async def user_usage_totals(
    days: int = Query(30, ge=1, le=365),
    user=Depends(get_current_user),
):
    return await get_user_usage(user["id"], days=days)


@router.get("/providers")
async def user_usage_by_provider(
    days: int = Query(30, ge=1, le=365),
    user=Depends(get_current_user),
):
    return await get_user_usage_by_provider(user["id"], days=days)


@router.get("/daily")
async def user_daily_usage(
    days: int = Query(30, ge=1, le=365),
    user=Depends(get_current_user),
):
    return await get_user_daily_usage(user["id"], days=days)


@router.get("/projects")
async def all_projects_usage(
    days: int = Query(30, ge=1, le=365),
    user=Depends(get_current_user),
):
    return await get_all_projects_usage(user["id"], days=days)


@router.get("/projects/{project_id}")
async def project_usage_totals(
    project_id: str,
    user=Depends(get_current_user),
):
    return await get_project_usage(project_id)


@router.get("/stages")
async def user_usage_by_stage(
    days: int = Query(30, ge=1, le=365),
    user=Depends(get_current_user),
):
    return await get_user_usage_by_stage(user["id"], days=days)


@router.get("/projects/{project_id}/stages")
async def project_usage_by_stage(
    project_id: str,
    user=Depends(get_current_user),
):
    return await get_project_usage_by_stage(project_id)
