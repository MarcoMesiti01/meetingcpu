import builtins

import pytest

from app.diarization import DiarizationUnavailable, LocalDiarizer


def test_local_diarizer_reports_unavailable_when_model_files_are_missing(tmp_path):
    diarizer = LocalDiarizer(model_dir=tmp_path / "missing")

    assert diarizer.is_available() is False

    with pytest.raises(DiarizationUnavailable) as error:
        diarizer.diarize("recording.webm")

    assert "Diarization model files are missing" in str(error.value)


def test_local_diarizer_does_not_import_pyannote_when_model_files_are_missing(
    tmp_path, monkeypatch
):
    original_import = builtins.__import__

    def reject_pyannote(name, *args, **kwargs):
        if name == "pyannote.audio":
            raise AssertionError("pyannote imported before local model check")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", reject_pyannote)

    diarizer = LocalDiarizer(model_dir=tmp_path / "missing")

    assert diarizer.is_available() is False
