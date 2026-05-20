import builtins
import importlib.util
import sys
import types
from pathlib import Path

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


def load_download_script():
    repo_root = Path(__file__).resolve().parents[3]
    script_path = repo_root / "scripts" / "download-diarization.py"
    spec = importlib.util.spec_from_file_location("download_diarization_test", script_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_download_script_model_dir_is_anchored_to_repo_root(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)

    module = load_download_script()

    assert module.MODEL_DIR == Path(__file__).resolve().parents[3] / "models" / "diarization"


def test_download_script_verifies_saved_model_can_be_loaded(monkeypatch, tmp_path):
    module = load_download_script()
    module.MODEL_DIR = tmp_path / "models" / "diarization"
    calls = []

    class FakePipeline:
        @classmethod
        def from_pretrained(cls, model_id, use_auth_token=None):
            calls.append((model_id, use_auth_token))
            return cls()

        def save_pretrained(self, model_dir):
            Path(model_dir, "config.yaml").write_text("pipeline: fake\n")

    fake_pyannote = types.ModuleType("pyannote")
    fake_audio = types.ModuleType("pyannote.audio")
    fake_audio.Pipeline = FakePipeline
    monkeypatch.setitem(sys.modules, "pyannote", fake_pyannote)
    monkeypatch.setitem(sys.modules, "pyannote.audio", fake_audio)
    monkeypatch.setenv("HF_TOKEN", "token")
    monkeypatch.setattr(sys, "argv", ["download-diarization.py"])

    module.main()

    assert calls == [
        (module.MODEL_ID, "token"),
        (str(module.MODEL_DIR), None),
    ]
