from fastapi import APIRouter

from models import IntentRequest, IntentResponse

router = APIRouter(prefix="/api", tags=["intent"])


@router.post("/intent", response_model=IntentResponse)
async def capture_intent(payload: IntentRequest) -> IntentResponse:
    """
    Accepts the user's high-level writing intent and stores it as the
    seed for subsequent literature search and drafting steps.
    """
    return IntentResponse(
        status="success",
        message=(
            f"Intent captured. Ready to begin {payload.writing_type.value} "
            f"pipeline for: '{payload.key_idea[:80]}{'...' if len(payload.key_idea) > 80 else ''}'."
        ),
        received=payload,
    )
