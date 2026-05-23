from pathlib import Path


class DiarizationUnavailable(Exception):
    pass


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
        diarization = pipeline(audio_path)
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
