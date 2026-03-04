from services.revision_docx_builder import build_point_by_point_docx


def test_point_by_point_docx_accepts_copy_paste_and_citations():
    revision_round = {
        "journal_name": "Test Journal",
        "responses": [
            {
                "reviewer_number": 1,
                "comment_number": 1,
                "original_comment": "Please improve clarity in the introduction.",
                "author_response": "We revised the introduction for clarity.",
                "action_taken": "Introduction, paragraph 2, Lines 30-36: clarified rationale.",
                "manuscript_diff": '{"deleted":"Old sentence.","added":"New clearer sentence."}',
                "copy_paste_text": "This study addresses the gap by...",
                "citation_suggestions": ["10.1000/testdoi", "Smith et al., 2021"],
            }
        ],
    }
    data = build_point_by_point_docx(revision_round, manuscript_title="Title")
    assert isinstance(data, (bytes, bytearray))
    assert len(data) > 200
