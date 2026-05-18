from fastapi.testclient import TestClient

from app.main import create_app
from app.transcriber import AudioUnreadableError


class FakeTranscriber:
    def transcribe(self, audio_path, model_id, language):
        return {
            "text": "Hello from Python.",
            "language": language or "en",
            "durationSeconds": 1.2,
            "segments": [{"start": 0, "end": 1.2, "text": "Hello from Python."}],
        }


class FailingTranscriber:
    def __init__(self, error):
        self.error = error

    def transcribe(self, audio_path, model_id, language):
        raise self.error


def test_importing_main_does_not_require_faster_whisper(monkeypatch):
    import builtins
    import importlib
    import sys

    original_import = builtins.__import__

    def reject_faster_whisper(name, *args, **kwargs):
        if name == "faster_whisper":
            raise AssertionError("faster_whisper imported eagerly")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", reject_faster_whisper)
    sys.modules.pop("app.main", None)
    main = importlib.import_module("app.main")

    assert main.create_app is not None
    assert "faster_whisper" not in sys.modules


def test_health_endpoint():
    client = TestClient(create_app(FakeTranscriber()))
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"ok": True, "service": "meetingcpu-whisper"}


def test_transcribe_endpoint_returns_transcript():
    client = TestClient(create_app(FakeTranscriber()))
    response = client.post(
        "/transcribe",
        json={"audioPath": "recording.webm", "modelId": "small", "language": None},
    )
    assert response.status_code == 200
    assert response.json()["text"] == "Hello from Python."


def test_transcribe_endpoint_rejects_unknown_model():
    client = TestClient(create_app(FakeTranscriber()))
    response = client.post(
        "/transcribe",
        json={"audioPath": "recording.webm", "modelId": "bad-model", "language": None},
    )
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "UNKNOWN_MODEL"


def test_transcribe_endpoint_maps_audio_unreadable_error():
    client = TestClient(
        create_app(FailingTranscriber(AudioUnreadableError("Missing file")))
    )
    response = client.post(
        "/transcribe",
        json={"audioPath": "missing.webm", "modelId": "small", "language": None},
    )
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "AUDIO_UNREADABLE"


def test_transcribe_endpoint_maps_runtime_error():
    client = TestClient(create_app(FailingTranscriber(RuntimeError("No local model"))))
    response = client.post(
        "/transcribe",
        json={"audioPath": "recording.webm", "modelId": "small", "language": None},
    )
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "MODEL_UNAVAILABLE"


def test_transcribe_endpoint_maps_memory_error():
    client = TestClient(create_app(FailingTranscriber(MemoryError())))
    response = client.post(
        "/transcribe",
        json={"audioPath": "recording.webm", "modelId": "small", "language": None},
    )
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "MODEL_TOO_HEAVY"
