"""
services/docx_pdf_converter.py

Convert Word .docx files to PDF via headless LibreOffice.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tempfile
import textwrap
import unicodedata
from pathlib import Path

logger = logging.getLogger(__name__)


def _resolve_soffice_binary() -> str:
    for candidate in ("soffice", "libreoffice"):
        binary = shutil.which(candidate)
        if binary:
            return binary
    raise RuntimeError("LibreOffice is not installed or `soffice` is not on PATH.")


def _normalise_pdf_text(text: str) -> str:
    return unicodedata.normalize("NFKD", text).encode("latin-1", "replace").decode("latin-1")


def _escape_pdf_text(text: str) -> str:
    return (
        _normalise_pdf_text(text)
        .replace("\\", "\\\\")
        .replace("(", "\\(")
        .replace(")", "\\)")
    )


def _build_line_numbered_lines(docx_bytes: bytes, wrap_width: int = 88) -> list[str]:
    from services.manuscript_importer import extract_text_from_docx

    extracted = extract_text_from_docx(docx_bytes)
    source_lines = extracted.splitlines() or [""]
    rendered_lines: list[str] = []
    line_number = 1

    for raw_line in source_lines:
        wrapped = textwrap.wrap(
            raw_line,
            width=wrap_width,
            replace_whitespace=False,
            drop_whitespace=False,
            break_long_words=True,
            break_on_hyphens=False,
        ) or [""]
        for segment in wrapped:
            rendered_lines.append(f"{line_number:04d}  {segment}")
            line_number += 1

    return rendered_lines or ["0001  "]


def _pdf_stream_object(data: bytes) -> bytes:
    return b"<< /Length " + str(len(data)).encode("ascii") + b" >>\nstream\n" + data + b"\nendstream"


def _write_basic_text_pdf(lines: list[str], output_pdf_path: str) -> str:
    page_width = 612
    page_height = 792
    left_margin = 54
    top_margin = 54
    line_height = 12
    lines_per_page = 56
    font_size = 9

    pages = [lines[i:i + lines_per_page] for i in range(0, len(lines), lines_per_page)] or [["0001  "]]
    objects: list[bytes] = []

    def add_object(payload: bytes) -> int:
        objects.append(payload)
        return len(objects)

    pages_id = add_object(b"")
    font_id = add_object(b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>")
    page_ids: list[int] = []

    for page_lines in pages:
        commands = [
            "1 1 1 rg",
            f"0 0 {page_width} {page_height} re",
            "f",
            "0 0 0 rg",
            "BT",
            f"/F1 {font_size} Tf",
        ]
        y = page_height - top_margin
        for line in page_lines:
            commands.append(f"1 0 0 1 {left_margin} {y} Tm")
            commands.append(f"({_escape_pdf_text(line)}) Tj")
            y -= line_height
        commands.append("ET")
        content_id = add_object(_pdf_stream_object("\n".join(commands).encode("latin-1")))
        page_id = add_object(
            (
                f"<< /Type /Page /Parent {pages_id} 0 R "
                f"/MediaBox [0 0 {page_width} {page_height}] "
                f"/Resources << /Font << /F1 {font_id} 0 R >> >> "
                f"/Contents {content_id} 0 R >>"
            ).encode("ascii")
        )
        page_ids.append(page_id)

    kids = " ".join(f"{pid} 0 R" for pid in page_ids)
    objects[pages_id - 1] = (
        f"<< /Type /Pages /Kids [{kids}] /Count {len(page_ids)} >>"
    ).encode("ascii")
    catalog_id = add_object(f"<< /Type /Catalog /Pages {pages_id} 0 R >>".encode("ascii"))

    os.makedirs(os.path.dirname(output_pdf_path) or ".", exist_ok=True)
    with open(output_pdf_path, "wb") as f:
        f.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        offsets = [0]
        for idx, obj in enumerate(objects, start=1):
            offsets.append(f.tell())
            f.write(f"{idx} 0 obj\n".encode("ascii"))
            f.write(obj)
            f.write(b"\nendobj\n")
        xref_offset = f.tell()
        f.write(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
        f.write(b"0000000000 65535 f \n")
        for offset in offsets[1:]:
            f.write(f"{offset:010d} 00000 n \n".encode("ascii"))
        f.write(
            (
                f"trailer\n<< /Size {len(objects) + 1} /Root {catalog_id} 0 R >>\n"
                f"startxref\n{xref_offset}\n%%EOF\n"
            ).encode("ascii")
        )

    return output_pdf_path


def _fallback_line_numbered_pdf(source_docx_path: str, output_pdf_path: str) -> str:
    docx_bytes = Path(source_docx_path).read_bytes()
    lines = _build_line_numbered_lines(docx_bytes)
    result = _write_basic_text_pdf(lines, output_pdf_path)
    logger.info(
        "Generated fallback line-numbered PDF for %s at %s",
        source_docx_path,
        output_pdf_path,
    )
    return result


def convert_docx_to_pdf(
    source_docx_path: str,
    output_pdf_path: str,
    timeout_seconds: int = 90,
) -> str:
    """Convert *source_docx_path* to *output_pdf_path* using headless LibreOffice."""
    if not os.path.exists(source_docx_path):
        raise RuntimeError(f"Source .docx not found: {source_docx_path}")

    os.makedirs(os.path.dirname(output_pdf_path) or ".", exist_ok=True)

    try:
        soffice = _resolve_soffice_binary()
        with tempfile.TemporaryDirectory(prefix="docx_pdf_") as tmp_outdir:
            cmd = [
                soffice,
                "--headless",
                "--convert-to",
                "pdf:writer_pdf_Export",
                "--outdir",
                tmp_outdir,
                source_docx_path,
            ]
            try:
                proc = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    check=False,
                    timeout=timeout_seconds,
                )
            except subprocess.TimeoutExpired as exc:
                raise RuntimeError(
                    f"Timed out converting {os.path.basename(source_docx_path)} to PDF."
                ) from exc

            if proc.returncode != 0:
                detail = (proc.stderr or proc.stdout or "").strip()
                raise RuntimeError(
                    f"LibreOffice PDF conversion failed for {os.path.basename(source_docx_path)}"
                    + (f": {detail}" if detail else ".")
                )

            expected_pdf = Path(tmp_outdir) / f"{Path(source_docx_path).stem}.pdf"
            if not expected_pdf.exists():
                generated_pdfs = sorted(Path(tmp_outdir).glob("*.pdf"))
                if len(generated_pdfs) == 1:
                    expected_pdf = generated_pdfs[0]
                else:
                    raise RuntimeError(
                        f"LibreOffice did not produce the expected PDF for {os.path.basename(source_docx_path)}."
                    )

            if os.path.exists(output_pdf_path):
                os.remove(output_pdf_path)
            shutil.move(str(expected_pdf), output_pdf_path)

        logger.info(
            "Converted %s to %s via LibreOffice",
            source_docx_path,
            output_pdf_path,
        )
        return output_pdf_path
    except Exception as exc:
        logger.warning(
            "LibreOffice PDF conversion unavailable for %s; using fallback line-numbered PDF. Reason: %s",
            source_docx_path,
            exc,
        )
        return _fallback_line_numbered_pdf(source_docx_path, output_pdf_path)
