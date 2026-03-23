from models import Paper
from services.paper_fetcher import FetchSettings, saved_pdf_path_for_paper


def test_saved_pdf_path_prefers_project_folder_full_papers() -> None:
    paper = Paper(
        title="Risk Behaviors and Psychological Impacts of Dating App Use in Emerging Adults",
        authors=["Chan, Alice", "Smith, Bob"],
        abstract="Test abstract",
        doi="10.1000/test",
        pmid=None,
        pmcid=None,
        year=2024,
        journal="Journal of Behavioral Research",
        citation_count=12,
        oa_pdf_url="https://example.org/paper.pdf",
        source="openalex",
    )

    path = saved_pdf_path_for_paper(
        paper,
        FetchSettings(pdf_save_enabled=True, project_folder="/tmp/project-123"),
    )

    assert path == (
        "/tmp/project-123/full_papers/"
        "Chan_2024_Journal_of_Behaviora_Risk_Behaviors_and_Psychological_Impacts.pdf"
    )


def test_saved_pdf_path_prefers_project_folder_even_when_custom_root_is_present() -> None:
    paper = Paper(
        title="Associations between co-occurring conditions and age of autism diagnosis",
        authors=["Jadav, Nikita"],
        abstract="Test abstract",
        doi=None,
        pmid=None,
        pmcid=None,
        year=2022,
        journal="Autism Research",
        citation_count=None,
        oa_pdf_url=None,
        source="semantic_scholar",
    )

    path = saved_pdf_path_for_paper(
        paper,
        FetchSettings(
            pdf_save_enabled=True,
            pdf_save_path="/tmp/custom-pdfs",
            project_folder="/tmp/project-456",
        ),
    )

    assert path == (
        "/tmp/project-456/full_papers/"
        "Jadav_2022_Autism_Research_Associations_between_co_occurring_condit.pdf"
    )


def test_saved_pdf_path_uses_custom_save_path_as_legacy_fallback() -> None:
    paper = Paper(
        title="Associations between co-occurring conditions and age of autism diagnosis",
        authors=["Jadav, Nikita"],
        abstract="Test abstract",
        doi=None,
        pmid=None,
        pmcid=None,
        year=2022,
        journal="Autism Research",
        citation_count=None,
        oa_pdf_url=None,
        source="semantic_scholar",
    )

    path = saved_pdf_path_for_paper(
        paper,
        FetchSettings(pdf_save_enabled=True, pdf_save_path="/tmp/custom-pdfs"),
    )

    assert path == (
        "/tmp/custom-pdfs/"
        "Jadav_2022_Autism_Research_Associations_between_co_occurring_condit.pdf"
    )
