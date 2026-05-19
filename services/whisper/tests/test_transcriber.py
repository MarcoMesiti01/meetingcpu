import pytest

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
