from fastapi.testclient import TestClient

from app.errors import AudioUnreadableError
from app.main import create_app


class FakeTranscriber:
    def __init__(self):
        self.calls = []

    def diarization_status(self):
        return {"available": True, "enabled": True}

    def transcribe(self, audio_path, model_id, language, diarization=True):
        self.calls.append(
            {
                "audio_path": audio_path,
                "model_id": model_id,
                "language": language,
                "diarization": diarization,
            }
        )
        return {
            "text": "Hello from Python.",
            "language": language or "en",
            "durationSeconds": 1.2,
            "segments": [
                {
                    "start": 0,
                    "end": 1.2,
                    "text": "Hello from Python.",
                    "speaker": "Speaker 1",
                }
            ],
            "diarization": {"available": True, "enabled": True},
        }


class FailingTranscriber:
    def __init__(self, error):
        self.error = error

    def transcribe(self, audio_path, model_id, language, diarization=True):
        raise self.error


class FakeHealthDiarizer:
    def __init__(self, available, error=None):
        self.available = available
        self.error = error

    def is_available(self):
        return self.available

    def unavailable_error(self):
        return self.error


def test_importing_main_does_not_require_transcriber_or_faster_whisper(monkeypatch):
    import builtins
    import importlib
    import sys

    original_import = builtins.__import__

    def reject_heavy_imports(name, *args, **kwargs):
        if name in {"app.transcriber", "faster_whisper", "pyannote.audio"}:
            raise AssertionError(f"{name} imported eagerly")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", reject_heavy_imports)
    sys.modules.pop("app.main", None)
    sys.modules.pop("app.transcriber", None)
    main = importlib.import_module("app.main")

    assert main.create_app is not None
    assert "app.transcriber" not in sys.modules
    assert "faster_whisper" not in sys.modules
    assert "pyannote.audio" not in sys.modules


def test_health_endpoint():
    client = TestClient(create_app(FakeTranscriber()))
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "service": "meetingcpu-whisper",
        "diarization": {"available": True, "enabled": True},
    }


def test_health_endpoint_reports_diarization_without_loading_transcriber(monkeypatch):
    import builtins

    original_import = builtins.__import__

    def reject_transcriber_and_model(name, *args, **kwargs):
        if name in {"app.transcriber", "faster_whisper", "pyannote.audio"}:
            raise AssertionError(f"{name} imported by /health")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", reject_transcriber_and_model)
    client = TestClient(
        create_app(
            transcriber=None,
            health_diarizer=FakeHealthDiarizer(False, "model files are missing"),
        )
    )

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "service": "meetingcpu-whisper",
        "diarization": {
            "available": False,
            "enabled": False,
            "error": "model files are missing",
        },
    }


def test_transcribe_endpoint_returns_transcript():
    transcriber = FakeTranscriber()
    client = TestClient(create_app(transcriber))
    response = client.post(
        "/transcribe",
        json={"audioPath": "recording.webm", "modelId": "small", "language": None},
    )
    assert response.status_code == 200
    assert response.json() == {
        "text": "Hello from Python.",
        "language": "en",
        "durationSeconds": 1.2,
        "segments": [
            {
                "start": 0,
                "end": 1.2,
                "text": "Hello from Python.",
                "speaker": "Speaker 1",
            }
        ],
        "diarization": {"available": True, "enabled": True},
    }
    assert transcriber.calls == [
        {
            "audio_path": "recording.webm",
            "model_id": "small",
            "language": None,
            "diarization": True,
        }
    ]


def test_transcribe_endpoint_forwards_disabled_diarization():
    transcriber = FakeTranscriber()
    client = TestClient(create_app(transcriber))
    response = client.post(
        "/transcribe",
        json={
            "audioPath": "recording.webm",
            "modelId": "small",
            "language": "en",
            "diarization": False,
        },
    )

    assert response.status_code == 200
    assert transcriber.calls == [
        {
            "audio_path": "recording.webm",
            "model_id": "small",
            "language": "en",
            "diarization": False,
        }
    ]


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
