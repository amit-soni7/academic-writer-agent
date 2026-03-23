from routers.sr_pipeline import _write_protocol_evidence_artifacts


def test_write_protocol_evidence_artifacts_saves_bib_and_paths(tmp_path):
    project_folder = tmp_path / "protocol-project"
    pack = {
        "bibtex": "@article{smith2024,\n  title = {Example}\n}",
        "references_md": "## References\n\nSmith (2024). Example.",
    }

    updated = _write_protocol_evidence_artifacts(str(project_folder), pack)

    bib_path = project_folder / "protocol_evidence_references.bib"
    assert bib_path.read_text(encoding="utf-8").startswith("@article{smith2024")
    assert updated["saved_bib_path"] == str(bib_path)
    assert updated["saved_full_papers_path"] == str(project_folder / "full_papers")
