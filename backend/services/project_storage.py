from __future__ import annotations

import filecmp
import logging
import os
import shutil
from typing import Any

from models import Paper, PaperSummary
from services.bibtex_generator import write_project_bib
from services.paper_fetcher import FetchSettings, saved_pdf_path_for_paper
from services.project_repo import (
    list_projects,
    load_project,
    resolve_project_folder_path,
    update_project_folder,
)
from services.secure_settings import get_user_app_settings

logger = logging.getLogger(__name__)

_FULL_TEXT_SOURCES = {"pmc_xml", "full_pdf", "full_html"}


def _paper_key_dict(paper: dict) -> str:
    doi = str(paper.get("doi") or "").strip().lower()
    if doi:
        return doi
    return str(paper.get("title") or "")[:60].lower().strip()


def _same_path(left: str | None, right: str | None) -> bool:
    if not left or not right:
        return False
    return os.path.abspath(left) == os.path.abspath(right)


def _cleanup_empty_dirs(path: str) -> None:
    if not path or not os.path.isdir(path):
        return
    for root, dirs, _files in os.walk(path, topdown=False):
        for dirname in dirs:
            candidate = os.path.join(root, dirname)
            try:
                os.rmdir(candidate)
            except OSError:
                pass
    try:
        os.rmdir(path)
    except OSError:
        pass


def _next_conflict_path(path: str, suffix: str) -> str:
    stem, ext = os.path.splitext(path)
    index = 1
    candidate = f"{stem}__{suffix}{ext}"
    while os.path.exists(candidate):
        index += 1
        candidate = f"{stem}__{suffix}{index}{ext}"
    return candidate


def _move_file(src: str, dst: str, *, conflict_suffix: str) -> str:
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if os.path.exists(dst):
        try:
            if filecmp.cmp(src, dst, shallow=False):
                os.remove(src)
                return "deduped"
        except Exception:
            pass
        dst = _next_conflict_path(dst, conflict_suffix)
    shutil.move(src, dst)
    return "moved"


def _copy_file(src: str, dst: str, *, conflict_suffix: str) -> str:
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if os.path.exists(dst):
        try:
            if filecmp.cmp(src, dst, shallow=False):
                return "deduped"
        except Exception:
            pass
        dst = _next_conflict_path(dst, conflict_suffix)
    shutil.copy2(src, dst)
    return "copied"


def _merge_move_tree(src: str | None, dst: str) -> int:
    if not src or _same_path(src, dst):
        os.makedirs(dst, exist_ok=True)
        return 0
    if not os.path.isdir(src):
        os.makedirs(dst, exist_ok=True)
        return 0

    moved_files = 0
    os.makedirs(dst, exist_ok=True)
    for root, _dirs, files in os.walk(src):
        rel = os.path.relpath(root, src)
        dst_root = dst if rel == "." else os.path.join(dst, rel)
        os.makedirs(dst_root, exist_ok=True)
        for filename in files:
            src_path = os.path.join(root, filename)
            dst_path = os.path.join(dst_root, filename)
            action = _move_file(src_path, dst_path, conflict_suffix="legacy")
            if action in {"moved", "deduped"}:
                moved_files += 1

    _cleanup_empty_dirs(src)
    return moved_files


def _is_full_text_summary(summary_data: dict[str, Any]) -> bool:
    text_source = str(summary_data.get("text_source") or "").strip().lower()
    return bool(summary_data.get("full_text_used")) or text_source in _FULL_TEXT_SOURCES


def _summary_models(project: dict[str, Any]) -> list[PaperSummary]:
    models: list[PaperSummary] = []
    for payload in (project.get("summaries") or {}).values():
        try:
            models.append(PaperSummary(**payload))
        except Exception as exc:
            logger.debug("Skipping invalid summary during BibTeX rebuild: %s", exc)
    return models


def _expected_pdf_records(project: dict[str, Any], project_folder: str) -> list[dict[str, str]]:
    papers_by_key = {
        _paper_key_dict(paper): paper
        for paper in project.get("papers", [])
        if isinstance(paper, dict)
    }
    records: list[dict[str, str]] = []
    for paper_key, summary_data in (project.get("summaries") or {}).items():
        if not isinstance(summary_data, dict) or not _is_full_text_summary(summary_data):
            continue
        paper_dict = papers_by_key.get(str(paper_key or "").strip().lower())
        if not paper_dict:
            records.append({
                "paper_key": str(paper_key),
                "title": "",
                "basename": "",
                "reason": "paper_missing_from_project",
            })
            continue
        try:
            paper = Paper(**paper_dict)
        except Exception:
            records.append({
                "paper_key": str(paper_key),
                "title": str(paper_dict.get("title") or ""),
                "basename": "",
                "reason": "invalid_paper_payload",
            })
            continue
        target_path = saved_pdf_path_for_paper(
            paper,
            FetchSettings(pdf_save_enabled=True, project_folder=project_folder),
        )
        records.append({
            "paper_key": str(paper_key),
            "title": paper.title,
            "basename": os.path.basename(target_path or ""),
            "reason": "",
        })
    return records


async def normalize_project_storage_for_user(user_id: str) -> dict:
    settings = await get_user_app_settings(user_id)
    custom_root = str(getattr(settings, "pdf_save_path", "") or "").strip()
    projects = await list_projects(user_id)

    report: dict[str, Any] = {
        "projects_updated": 0,
        "pdfs_moved": 0,
        "pdfs_copied": 0,
        "bibs_rebuilt": 0,
        "missing_pdfs": [],
        "unassigned_files": [],
        "projects": [],
    }
    if not projects:
        return report

    matched_root_pdf_targets: dict[str, list[dict[str, str]]] = {}
    project_expected_pdfs: dict[str, list[dict[str, str]]] = {}

    for item in projects:
        project = await load_project(user_id, item["project_id"])
        if project is None:
            continue

        display_name = str(project.get("project_name") or "").strip() or str(project.get("query") or "").strip() or "Project"
        old_folder = str(project.get("project_folder") or "").strip()
        target_folder = resolve_project_folder_path(display_name, pdf_save_path=custom_root or None)
        moved_existing_files = _merge_move_tree(old_folder, target_folder)

        folder_updated = False
        if not _same_path(old_folder, target_folder):
            await update_project_folder(project["project_id"], target_folder)
            folder_updated = True
            report["projects_updated"] += 1

        bib_result = write_project_bib(project["project_id"], target_folder, _summary_models(project))
        if bib_result.get("changed"):
            report["bibs_rebuilt"] += 1

        pdf_records = _expected_pdf_records(project, target_folder)
        project_expected_pdfs[project["project_id"]] = pdf_records
        for record in pdf_records:
            basename = record.get("basename") or ""
            if not basename:
                continue
            matched_root_pdf_targets.setdefault(basename, []).append({
                "project_id": project["project_id"],
                "project_name": display_name,
                "project_folder": target_folder,
                "paper_key": record["paper_key"],
                "title": record["title"],
                "target_path": os.path.join(target_folder, "full_papers", basename),
            })

        report["projects"].append({
            "project_id": project["project_id"],
            "project_name": display_name,
            "old_folder": old_folder,
            "target_folder": target_folder,
            "folder_updated": folder_updated,
            "existing_files_merged": moved_existing_files,
            "bib_path": bib_result.get("path"),
            "bib_entries": bib_result.get("entry_count", 0),
            "bib_rebuilt": bool(bib_result.get("changed")),
            "missing_pdf_count": 0,
        })

    if custom_root and os.path.isdir(custom_root):
        for basename, targets in matched_root_pdf_targets.items():
            src_path = os.path.join(custom_root, basename)
            if not os.path.isfile(src_path):
                continue

            unique_targets: list[str] = []
            seen: set[str] = set()
            for target in targets:
                target_path = target["target_path"]
                if target_path in seen:
                    continue
                seen.add(target_path)
                unique_targets.append(target_path)

            if len(unique_targets) <= 1:
                action = _move_file(src_path, unique_targets[0], conflict_suffix="project")
                if action in {"moved", "deduped"}:
                    report["pdfs_moved"] += 1
            else:
                for target_path in unique_targets:
                    action = _copy_file(src_path, target_path, conflict_suffix="project")
                    if action == "copied":
                        report["pdfs_copied"] += 1
                if os.path.exists(src_path):
                    os.remove(src_path)

        unassigned_root = os.path.join(custom_root, "_legacy_unassigned")
        for filename in sorted(os.listdir(custom_root)):
            src_path = os.path.join(custom_root, filename)
            if not os.path.isfile(src_path):
                continue
            lower = filename.lower()
            if lower.endswith(".pdf"):
                dst_path = os.path.join(unassigned_root, "pdfs", filename)
            elif lower.endswith(".bib"):
                dst_path = os.path.join(unassigned_root, "bib", filename)
            else:
                continue
            _move_file(src_path, dst_path, conflict_suffix="unassigned")
            report["unassigned_files"].append(dst_path)

    project_rows = {row["project_id"]: row for row in report["projects"]}
    for project_id, pdf_records in project_expected_pdfs.items():
        row = project_rows.get(project_id)
        if not row:
            continue
        target_folder = row["target_folder"]
        for record in pdf_records:
            basename = record.get("basename") or ""
            if not basename:
                report["missing_pdfs"].append({
                    "project_id": project_id,
                    "project_name": row["project_name"],
                    "paper_key": record.get("paper_key"),
                    "title": record.get("title"),
                    "expected_path": None,
                    "repair_needed": True,
                    "reason": record.get("reason") or "missing_expected_basename",
                })
                row["missing_pdf_count"] += 1
                continue
            expected_path = os.path.join(target_folder, "full_papers", basename)
            if not os.path.exists(expected_path):
                report["missing_pdfs"].append({
                    "project_id": project_id,
                    "project_name": row["project_name"],
                    "paper_key": record.get("paper_key"),
                    "title": record.get("title"),
                    "expected_path": expected_path,
                    "repair_needed": True,
                    "reason": "missing_after_normalization",
                })
                row["missing_pdf_count"] += 1

    return report
