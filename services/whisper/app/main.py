from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from app.errors import AudioUnreadableError
from app.model_catalog import get_model_option


class TranscribeRequest(BaseModel):
    audioPath: str
    modelId: str
    language: Optional[str] = None


def create_default_transcriber():
    from app.transcriber import LocalTranscriber

    return LocalTranscriber()


def create_app(transcriber=None):
    app = FastAPI(title="meetingcpu whisper service")
    active_transcriber = transcriber

    def get_active_transcriber():
        nonlocal active_transcriber
        if active_transcriber is None:
            active_transcriber = create_default_transcriber()
        return active_transcriber

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
            return get_active_transcriber().transcribe(
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
        except AudioUnreadableError as error:
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "AUDIO_UNREADABLE",
                    "message": str(error),
                },
            ) from error

    return app


app = create_app()
