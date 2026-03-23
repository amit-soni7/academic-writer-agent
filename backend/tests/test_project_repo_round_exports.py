from pathlib import Path

from services.project_repo import clear_round_exports, save_manuscript_files, save_round_export


def test_clear_round_exports_removes_existing_round_directory(tmp_path: Path):
    project_folder = tmp_path / "project"
    first_path = save_round_export(str(project_folder), 2, "track_changes.docx", b"old")
    second_path = save_round_export(str(project_folder), 2, "revised_manuscript.docx", b"old-clean")

    assert Path(first_path).exists()
    assert Path(second_path).exists()

    clear_round_exports(str(project_folder), 2)

    assert not (project_folder / "round_2").exists()


def test_save_round_export_can_write_fresh_files_after_clear(tmp_path: Path):
    project_folder = tmp_path / "project"
    save_round_export(str(project_folder), 3, "track_changes.docx", b"stale")
    clear_round_exports(str(project_folder), 3)

    new_path = save_round_export(str(project_folder), 3, "track_changes.docx", b"fresh")

    assert Path(new_path).read_bytes() == b"fresh"


def test_save_manuscript_files_removes_stale_docx_when_text_only_import_replaces_it(tmp_path: Path):
    project_folder = tmp_path / "project"

    first_paths = save_manuscript_files(str(project_folder), docx_bytes=b"docx-data", markdown_text="first")
    assert Path(first_paths["original_docx"]).exists()

    second_paths = save_manuscript_files(str(project_folder), docx_bytes=None, markdown_text="second")

    assert "original_docx" not in second_paths
    assert not (project_folder / "original_manuscript.docx").exists()
    assert (project_folder / "original_manuscript.md").read_text(encoding="utf-8") == "second"
