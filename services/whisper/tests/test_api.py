from fastapi.testclient import TestClient

from app.main import create_app


class FakeTranscriber:
    def transcribe(self, audio_path, model_id, language):
        return {
            "text": "Hello from Python.",
            "language": language or "en",
            "durationSeconds": 1.2,
            "segments": [{"start": 0, "end": 1.2, "text": "Hello from Python."}],
        }


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
