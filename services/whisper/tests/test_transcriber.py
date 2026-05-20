import pytest

from app.diarization import DiarizationUnavailable
from app.errors import AudioUnreadableError
from app.transcriber import LocalTranscriber


class BadAudioModel:
    def transcribe(self, audio_path, language, vad_filter, beam_size):
        raise ValueError("bad audio")


class BadSegmentIteratorModel:
    def transcribe(self, audio_path, language, vad_filter, beam_size):
        return failing_segments(), FakeInfo()


class FakeInfo:
    language = "en"
    duration = 1.0


class FakeSegment:
    def __init__(self, start, end, text):
        self.start = start
        self.end = end
        self.text = text


class GoodModel:
    def transcribe(self, audio_path, language, vad_filter, beam_size):
        return [FakeSegment(0, 1.0, " Hello ")], FakeInfo()


class AvailableDiarizer:
    def is_available(self):
        return True

    def diarize(self, audio_path):
        return [{"start": 0, "end": 1.0, "speaker": "Speaker 1"}]


class OffsetDiarizer:
    def __init__(self, turns):
        self.turns = turns

    def is_available(self):
        return True

    def diarize(self, audio_path):
        return self.turns


class UnavailableDiarizer:
    def is_available(self):
        return False

    def diarize(self, audio_path):
        raise AssertionError("unavailable diarizer should not be used")


class ErroringDiarizer:
    def __init__(self, error):
        self.error = error

    def is_available(self):
        return True

    def diarize(self, audio_path):
        raise self.error


def failing_segments():
    raise ValueError("bad segment")
    yield


def test_transcriber_wraps_model_decode_errors_as_audio_unreadable(tmp_path):
    audio_path = tmp_path / "recording.webm"
    audio_path.write_bytes(b"not real audio")
    transcriber = LocalTranscriber()
    transcriber._load_model = lambda model_id, compute_type: BadAudioModel()

    with pytest.raises(AudioUnreadableError) as error:
        transcriber.transcribe(str(audio_path), "small", None)

    assert str(audio_path) in str(error.value)
    assert "bad audio" in str(error.value)


def test_transcriber_wraps_segment_iteration_errors_as_audio_unreadable(tmp_path):
    audio_path = tmp_path / "recording.webm"
    audio_path.write_bytes(b"not real audio")
    transcriber = LocalTranscriber()
    transcriber._load_model = lambda model_id, compute_type: BadSegmentIteratorModel()

    with pytest.raises(AudioUnreadableError) as error:
        transcriber.transcribe(str(audio_path), "small", None)

    assert str(audio_path) in str(error.value)
    assert "bad segment" in str(error.value)


def test_transcriber_returns_chunk_shape_with_fake_diarization(tmp_path):
    audio_path = tmp_path / "recording.webm"
    audio_path.write_bytes(b"fake audio")
    transcriber = LocalTranscriber(diarizer=AvailableDiarizer())
    transcriber._load_model = lambda model_id, compute_type: GoodModel()

    result = transcriber.transcribe(str(audio_path), "small", None)

    assert result == {
        "text": "Hello",
        "language": "en",
        "durationSeconds": 1.0,
        "segments": [
            {"start": 0, "end": 1.0, "text": "Hello", "speaker": "Speaker 1"}
        ],
        "diarization": {"available": True, "enabled": True},
    }


def test_transcriber_returns_diarization_fallback_when_unavailable(tmp_path):
    audio_path = tmp_path / "recording.webm"
    audio_path.write_bytes(b"fake audio")
    transcriber = LocalTranscriber(diarizer=UnavailableDiarizer())
    transcriber._load_model = lambda model_id, compute_type: GoodModel()

    result = transcriber.transcribe(str(audio_path), "small", None)

    assert result["segments"] == [
        {"start": 0, "end": 1.0, "text": "Hello", "speaker": "Speaker 1"}
    ]
    assert result["diarization"]["available"] is False
    assert result["diarization"]["enabled"] is False
    assert result["diarization"]["error"]


def test_transcriber_returns_diarization_fallback_for_expected_diarizer_errors(tmp_path):
    audio_path = tmp_path / "recording.webm"
    audio_path.write_bytes(b"fake audio")
    transcriber = LocalTranscriber(
        diarizer=ErroringDiarizer(DiarizationUnavailable("model missing"))
    )
    transcriber._load_model = lambda model_id, compute_type: GoodModel()

    result = transcriber.transcribe(str(audio_path), "small", None)

    assert result["diarization"] == {
        "available": False,
        "enabled": False,
        "error": "model missing",
    }


def test_transcriber_does_not_hide_malformed_diarization_turns(tmp_path):
    audio_path = tmp_path / "recording.webm"
    audio_path.write_bytes(b"fake audio")
    transcriber = LocalTranscriber(
        diarizer=OffsetDiarizer([{"start": 0, "end": 1.0}])
    )
    transcriber._load_model = lambda model_id, compute_type: GoodModel()

    with pytest.raises(ValueError, match="Malformed diarization turn"):
        transcriber.transcribe(str(audio_path), "small", None)


def test_transcriber_disables_diarization_when_turns_do_not_overlap_segments(tmp_path):
    audio_path = tmp_path / "recording.webm"
    audio_path.write_bytes(b"fake audio")
    transcriber = LocalTranscriber(
        diarizer=OffsetDiarizer([{"start": 3.0, "end": 4.0, "speaker": "Speaker 2"}])
    )
    transcriber._load_model = lambda model_id, compute_type: GoodModel()

    result = transcriber.transcribe(str(audio_path), "small", None)

    assert result["segments"] == [
        {"start": 0, "end": 1.0, "text": "Hello", "speaker": "Speaker 1"}
    ]
    assert result["diarization"]["available"] is True
    assert result["diarization"]["enabled"] is False
    assert result["diarization"]["error"]


def test_transcriber_ignores_tiny_diarization_overlap(tmp_path):
    audio_path = tmp_path / "recording.webm"
    audio_path.write_bytes(b"fake audio")
    transcriber = LocalTranscriber(
        diarizer=OffsetDiarizer([{"start": 0.99, "end": 2.0, "speaker": "Speaker 2"}])
    )
    transcriber._load_model = lambda model_id, compute_type: GoodModel()

    result = transcriber.transcribe(str(audio_path), "small", None)

    assert result["segments"] == [
        {"start": 0, "end": 1.0, "text": "Hello", "speaker": "Speaker 1"}
    ]
    assert result["diarization"]["available"] is True
    assert result["diarization"]["enabled"] is False
