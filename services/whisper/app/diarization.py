import os
from pathlib import Path


class DiarizationUnavailable(Exception):
    pass


_ffmpeg_dll_directory = None


def configure_ffmpeg_runtime(is_windows=None, local_app_data=None):
    if is_windows is None:
        is_windows = os.name == "nt"
    if not is_windows:
        return None

    for bin_dir in _ffmpeg_bin_candidates(local_app_data):
        if not (bin_dir / "ffmpeg.exe").is_file():
            continue
        if not next(bin_dir.glob("avcodec-*.dll"), None):
            continue

        current_path = os.environ.get("PATH", "")
        entries = [entry for entry in current_path.split(os.pathsep) if entry]
        entries = [entry for entry in entries if entry.casefold() != str(bin_dir).casefold()]
        os.environ["PATH"] = os.pathsep.join([str(bin_dir), *entries])

        global _ffmpeg_dll_directory
        add_dll_directory = getattr(os, "add_dll_directory", None)
        if add_dll_directory is not None:
            _ffmpeg_dll_directory = add_dll_directory(str(bin_dir))
        return bin_dir

    return None


def _ffmpeg_bin_candidates(local_app_data=None):
    configured_path = os.environ.get("FFMPEG_PATH", "").strip().strip('"').strip("'")
    if configured_path:
        yield Path(configured_path).parent

    for entry in os.environ.get("PATH", "").split(os.pathsep):
        if entry:
            yield Path(entry)

    app_data = Path(local_app_data or os.environ.get("LOCALAPPDATA", ""))
    packages_dir = app_data / "Microsoft" / "WinGet" / "Packages"
    if packages_dir.is_dir():
        for executable in packages_dir.glob("*FFmpeg*Shared*/**/bin/ffmpeg.exe"):
            yield executable.parent


class LocalDiarizer:
    def __init__(self, model_dir="models/diarization"):
        self.model_dir = Path(model_dir)
        self._pipeline = None
        self._unavailable_error = None

    def is_available(self) -> bool:
        try:
            self._load_pipeline()
        except DiarizationUnavailable as error:
            self._unavailable_error = str(error)
            return False
        return True

    def unavailable_error(self):
        return self._unavailable_error

    def diarize(self, audio_path: str) -> list[dict]:
        pipeline = self._load_pipeline()
        output = pipeline(audio_path, preload=True)
        diarization = getattr(output, "speaker_diarization", output)
        speakers = {}
        turns = []

        for turn, _, speaker in diarization.itertracks(yield_label=True):
            if speaker not in speakers:
                speakers[speaker] = f"Speaker {len(speakers) + 1}"
            turns.append(
                {
                    "start": float(turn.start),
                    "end": float(turn.end),
                    "speaker": speakers[speaker],
                }
            )

        return turns

    def _load_pipeline(self):
        if self._pipeline is not None:
            return self._pipeline
        if not (self.model_dir / "config.yaml").is_file():
            raise DiarizationUnavailable(
                f"Diarization model files are missing at {self.model_dir}. "
                "Run npm run download:diarization after accepting the pyannote "
                "model terms and setting HF_TOKEN."
            )

        try:
            configure_ffmpeg_runtime()
            from pyannote.audio import Pipeline
        except ImportError as error:
            raise DiarizationUnavailable(
                "pyannote.audio is not installed. Install optional diarization "
                "dependencies before running npm run download:diarization."
            ) from error

        try:
            self._pipeline = Pipeline.from_pretrained(str(self.model_dir))
        except Exception as error:
            raise DiarizationUnavailable(
                f"Diarization model could not be loaded from {self.model_dir}: {error}"
            ) from error

        return self._pipeline
