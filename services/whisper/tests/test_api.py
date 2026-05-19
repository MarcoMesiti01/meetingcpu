from fastapi.testclient import TestClient

from app.errors import AudioUnreadableError
from app.main import create_app


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


def test_importing_main_does_not_require_transcriber_or_faster_whisper(monkeypatch):
    import builtins
    import importlib
    import sys

    original_import = builtins.__import__

    def reject_heavy_imports(name, *args, **kwargs):
        if name in {"app.transcriber", "faster_whisper"}:
            raise AssertionError(f"{name} imported eagerly")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", reject_heavy_imports)
    sys.modules.pop("app.main", None)
    sys.modules.pop("app.transcriber", None)
    main = importlib.import_module("app.main")

    assert main.create_app is not None
    assert "app.transcriber" not in sys.modules
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
