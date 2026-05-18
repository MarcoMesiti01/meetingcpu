from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from app.model_catalog import get_model_option
from app.transcriber import LocalTranscriber


class TranscribeRequest(BaseModel):
    audioPath: str
    modelId: str
    language: Optional[str] = None


def create_app(transcriber=None):
    app = FastAPI(title="meetingcpu whisper service")
    active_transcriber = transcriber or LocalTranscriber()

    @app.get("/health")
    def health():
        return {"ok": True, "service": "meetingcpu-whisper"}

    @app.post("/transcribe")
    def transcribe(request: TranscribeRequest):
        if get_model_option(request.modelId) is None:
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "UNKNOWN_MODEL",
                    "message": f"Unknown model: {request.modelId}",
                    "suggestedModelIds": ["small", "base", "tiny"],
                },
            )

        try:
            return active_transcriber.transcribe(
                request.audioPath, request.modelId, request.language
            )
        except RuntimeError as error:
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "MODEL_UNAVAILABLE",
                    "message": str(error),
                    "suggestedModelIds": ["small", "base", "tiny"],
                },
            ) from error
        except MemoryError as error:
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "MODEL_TOO_HEAVY",
                    "message": "The selected model could not fit in available memory.",
                    "suggestedModelIds": ["small", "base", "tiny"],
                },
            ) from error

    return app


app = create_app()
