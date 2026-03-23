from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from models import Paper, PaperSummary
from services.paper_fetcher import FetchSettings, saved_pdf_path_for_paper
from services.project_storage import normalize_project_storage_for_user


def _paper_key(paper: dict) -> str:
    return (paper.get("doi") or (paper.get("title") or "")[:60]).lower().strip()


@pytest.mark.asyncio
async def test_normalize_project_storage_moves_and_rebuilds_legacy_files(tmp_path, monkeypatch):
    legacy_root = tmp_path / "write_pdf"
    default_root = tmp_path / "default_projects"
    legacy_root.mkdir()
    default_root.mkdir()

    paper_unique = {
        "title": "Unique Empirical Paper",
        "authors": ["Alpha, Alice"],
        "abstract": "Abstract",
        "doi": "10.1000/unique",
        "pmid": None,
        "pmcid": None,
        "year": 2024,
        "journal": "Journal of Tests",
        "citation_count": 3,
        "oa_pdf_url": None,
        "source": "openalex",
    }
    paper_shared = {
        "title": "Shared Review Paper",
        "authors": ["Beta, Bob"],
        "abstract": "Abstract",
        "doi": "10.1000/shared",
        "pmid": None,
        "pmcid": None,
        "year": 2023,
        "journal": "Evidence Reports",
        "citation_count": 7,
        "oa_pdf_url": None,
        "source": "semantic_scholar",
    }

    alpha_target = legacy_root / "Project_Alpha"
    beta_target = legacy_root / "Project_Beta"

    unique_basename = Path(
        saved_pdf_path_for_paper(
            Paper(**paper_unique),
            FetchSettings(pdf_save_enabled=True, project_folder=str(alpha_target)),
        ) or ""
    ).name
    shared_basename = Path(
        saved_pdf_path_for_paper(
            Paper(**paper_shared),
            FetchSettings(pdf_save_enabled=True, project_folder=str(alpha_target)),
        ) or ""
    ).name

    (legacy_root / unique_basename).write_bytes(b"unique-pdf")
    (legacy_root / shared_basename).write_bytes(b"shared-pdf")
    (legacy_root / "unmatched.pdf").write_bytes(b"orphan-pdf")
    (legacy_root / "write_pdf.bib").write_text("@article{legacy,\n}\n", encoding="utf-8")

    alpha_old = default_root / "Project_Alpha"
    alpha_old.mkdir()
    (alpha_old / "notes.txt").write_text("keep me", encoding="utf-8")

    projects_by_id = {
        "alpha1": {
            "project_id": "alpha1",
            "project_name": "Project Alpha",
            "query": "alpha query",
            "project_folder": str(alpha_old),
            "papers": [paper_unique, paper_shared],
            "summaries": {
                _paper_key(paper_unique): PaperSummary(
                    paper_key=_paper_key(paper_unique),
                    full_text_used=True,
                    text_source="full_pdf",
                    bibliography={
                        "title": paper_unique["title"],
                        "authors": paper_unique["authors"],
                        "journal": paper_unique["journal"],
                        "year": paper_unique["year"],
                        "doi": paper_unique["doi"],
                    },
                ).model_dump(),
                _paper_key(paper_shared): PaperSummary(
                    paper_key=_paper_key(paper_shared),
                    full_text_used=True,
                    text_source="full_pdf",
                    bibliography={
                        "title": paper_shared["title"],
                        "authors": paper_shared["authors"],
                        "journal": paper_shared["journal"],
                        "year": paper_shared["year"],
                        "doi": paper_shared["doi"],
                    },
                ).model_dump(),
            },
        },
        "beta1": {
            "project_id": "beta1",
            "project_name": "Project Beta",
            "query": "beta query",
            "project_folder": str(default_root / "Project_Beta"),
            "papers": [paper_shared],
            "summaries": {
                _paper_key(paper_shared): PaperSummary(
                    paper_key=_paper_key(paper_shared),
                    full_text_used=True,
                    text_source="full_pdf",
                    bibliography={
                        "title": paper_shared["title"],
                        "authors": paper_shared["authors"],
                        "journal": paper_shared["journal"],
                        "year": paper_shared["year"],
                        "doi": paper_shared["doi"],
                    },
                ).model_dump(),
            },
        },
    }

    async def _fake_list_projects(_user_id: str):
        return [
            {
                "project_id": project["project_id"],
                "project_name": project["project_name"],
                "project_folder": project["project_folder"],
            }
            for project in projects_by_id.values()
        ]

    async def _fake_load_project(_user_id: str, project_id: str):
        return projects_by_id.get(project_id)

    async def _fake_update_project_folder(project_id: str, folder: str):
        projects_by_id[project_id]["project_folder"] = folder

    async def _fake_get_user_app_settings(_user_id: str):
        return SimpleNamespace(pdf_save_path=str(legacy_root))

    monkeypatch.setattr("services.project_storage.get_user_app_settings", _fake_get_user_app_settings)
    monkeypatch.setattr("services.project_storage.list_projects", _fake_list_projects)
    monkeypatch.setattr("services.project_storage.load_project", _fake_load_project)
    monkeypatch.setattr("services.project_storage.update_project_folder", _fake_update_project_folder)

    first = await normalize_project_storage_for_user("user-1")

    assert projects_by_id["alpha1"]["project_folder"] == str(alpha_target)
    assert projects_by_id["beta1"]["project_folder"] == str(beta_target)
    assert (alpha_target / "notes.txt").read_text(encoding="utf-8") == "keep me"

    assert (alpha_target / "full_papers" / unique_basename).read_bytes() == b"unique-pdf"
    assert (alpha_target / "full_papers" / shared_basename).read_bytes() == b"shared-pdf"
    assert (beta_target / "full_papers" / shared_basename).read_bytes() == b"shared-pdf"
    assert not (legacy_root / unique_basename).exists()
    assert not (legacy_root / shared_basename).exists()

    assert (alpha_target / "Project_Alpha.bib").exists()
    assert (beta_target / "Project_Beta.bib").exists()
    assert not (legacy_root / "write_pdf.bib").exists()
    assert (legacy_root / "_legacy_unassigned" / "pdfs" / "unmatched.pdf").exists()
    assert (legacy_root / "_legacy_unassigned" / "bib" / "write_pdf.bib").exists()

    assert first["projects_updated"] == 2
    assert first["pdfs_moved"] == 1
    assert first["pdfs_copied"] == 2
    assert first["bibs_rebuilt"] == 2
    assert first["missing_pdfs"] == []
    assert len(first["unassigned_files"]) == 2

    second = await normalize_project_storage_for_user("user-1")

    assert second["projects_updated"] == 0
    assert second["pdfs_moved"] == 0
    assert second["pdfs_copied"] == 0
    assert second["bibs_rebuilt"] == 0
    assert second["missing_pdfs"] == []
    assert second["unassigned_files"] == []
