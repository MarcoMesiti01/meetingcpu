import pytest

from app.errors import AudioUnreadableError
from app.transcriber import LocalTranscriber


class BadAudioModel:
    def transcribe(self, audio_path, language, vad_filter, beam_size):
        raise ValueError("bad audio")


def test_transcriber_wraps_model_decode_errors_as_audio_unreadable(tmp_path):
    audio_path = tmp_path / "recording.webm"
    audio_path.write_bytes(b"not real audio")
    transcriber = LocalTranscriber()
    transcriber._load_model = lambda model_id, compute_type: BadAudioModel()

    with pytest.raises(AudioUnreadableError) as error:
        transcriber.transcribe(str(audio_path), "small", None)

    assert str(audio_path) in str(error.value)
    assert "bad audio" in str(error.value)
