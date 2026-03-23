import json
import subprocess
import sys
from pathlib import Path


def test_verify_docx_revisions_script_reports_all_checks_pass(tmp_path):
    backend_dir = Path(__file__).resolve().parents[1]
    script_path = backend_dir / "scripts" / "verify_docx_revisions.py"
    output_path = tmp_path / "docx_revisions_verification.docx"

    result = subprocess.run(
        [sys.executable, str(script_path), "--output", str(output_path)],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr

    payload = json.loads(result.stdout)
    assert payload["insertions_present"] is True
    assert payload["deletions_present"] is True
    assert payload["trackRevisions_present"] is True
    assert payload["revisionView_present"] is True
    assert payload["comments_disabled_in_revisionView"] is True
    assert payload["comments_part_present"] is False
    assert payload["comment_references_present"] is False
    assert payload["ins_count"] >= 1
    assert payload["del_count"] >= 1
    assert output_path.exists()
