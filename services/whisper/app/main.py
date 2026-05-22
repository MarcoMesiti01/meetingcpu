from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from app.errors import AudioUnreadableError
from app.model_catalog import get_model_option


class TranscribeRequest(BaseModel):
    audioPath: str
    modelId: str
    language: Optional[str] = None
    diarization: bool = True


def create_default_transcriber():
    from app.transcriber import LocalTranscriber

    return LocalTranscriber()


def create_default_diarizer():
    from app.diarization import LocalDiarizer

    return LocalDiarizer()


def create_app(transcriber=None, health_diarizer=None):
    app = FastAPI(title="meetingcpu whisper service")
    active_transcriber = transcriber
    active_health_diarizer = health_diarizer

    def get_active_transcriber():
        nonlocal active_transcriber
        if active_transcriber is None:
            active_transcriber = create_default_transcriber()
        return active_transcriber

    def get_health_diarizer():
        nonlocal active_health_diarizer
        if active_health_diarizer is None:
            active_health_diarizer = create_default_diarizer()
        return active_health_diarizer

    def get_diarization_status():
        if active_transcriber is not None and hasattr(
            active_transcriber, "diarization_status"
        ):
            return active_transcriber.diarization_status()

        diarizer = get_health_diarizer()
        if diarizer.is_available():
            return {"available": True, "enabled": True}

        status = {"available": False, "enabled": False}
        if hasattr(diarizer, "unavailable_error"):
            error = diarizer.unavailable_error()
            if error:
                status["error"] = error
        return status

    @app.get("/health")
    def health():
        return {
            "ok": True,
            "service": "meetingcpu-whisper",
            "diarization": get_diarization_status(),
        }

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
                request.audioPath,
                request.modelId,
                request.language,
                request.diarization,
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
