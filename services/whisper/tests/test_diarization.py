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


def test_download_script_reads_token_from_powershell_style_env_file(monkeypatch, tmp_path):
    module = load_download_script()
    module.ENV_PATH = tmp_path / ".env"
    module.ENV_PATH.write_text('$env:HF_TOKEN="private-token"\n')
    monkeypatch.delenv("HF_TOKEN", raising=False)

    assert module.load_hf_token() == "private-token"


def test_download_script_verifies_saved_model_can_be_loaded(monkeypatch, tmp_path):
    module = load_download_script()
    module.MODEL_DIR = tmp_path / "models" / "diarization"
    calls = []

    def fake_snapshot_download(repo_id, local_dir, token):
        calls.append(("snapshot", repo_id, Path(local_dir), token))
        Path(local_dir).mkdir(parents=True, exist_ok=True)
        Path(local_dir, "config.yaml").write_text("pipeline: fake\n")

    class FakePipeline:
        @classmethod
        def from_pretrained(cls, model_id):
            calls.append(("pipeline", model_id))
            return cls()

    fake_truststore = types.ModuleType("truststore")
    fake_truststore.inject_into_ssl = lambda: calls.append(("truststore",))
    fake_huggingface = types.ModuleType("huggingface_hub")
    fake_huggingface.snapshot_download = fake_snapshot_download
    fake_pyannote = types.ModuleType("pyannote")
    fake_audio = types.ModuleType("pyannote.audio")
    fake_audio.Pipeline = FakePipeline
    monkeypatch.setitem(sys.modules, "truststore", fake_truststore)
    monkeypatch.setitem(sys.modules, "huggingface_hub", fake_huggingface)
    monkeypatch.setitem(sys.modules, "pyannote", fake_pyannote)
    monkeypatch.setitem(sys.modules, "pyannote.audio", fake_audio)
    monkeypatch.setenv("HF_TOKEN", "token")
    monkeypatch.setattr(sys, "argv", ["download-diarization.py"])

    module.main()

    assert calls == [
        ("truststore",),
        ("snapshot", module.MODEL_ID, module.MODEL_DIR, "token"),
        ("pipeline", str(module.MODEL_DIR)),
    ]


def test_local_diarizer_reads_pyannote_4_speaker_diarization_output(monkeypatch, tmp_path):
    model_dir = tmp_path / "model"
    model_dir.mkdir()
    (model_dir / "config.yaml").write_text("pipeline: fake\n")

    class Turn:
        start = 0.0
        end = 1.5

    class Annotation:
        def itertracks(self, yield_label=False):
            assert yield_label is True
            yield Turn(), None, "SPEAKER_00"

    class Output:
        speaker_diarization = Annotation()

    class FakePipeline:
        @classmethod
        def from_pretrained(cls, model_path):
            return cls()

        def __call__(self, audio_path):
            return Output()

    fake_pyannote = types.ModuleType("pyannote")
    fake_audio = types.ModuleType("pyannote.audio")
    fake_audio.Pipeline = FakePipeline
    monkeypatch.setitem(sys.modules, "pyannote", fake_pyannote)
    monkeypatch.setitem(sys.modules, "pyannote.audio", fake_audio)

    assert LocalDiarizer(model_dir=model_dir).diarize("recording.wav") == [
        {"start": 0.0, "end": 1.5, "speaker": "Speaker 1"}
    ]
