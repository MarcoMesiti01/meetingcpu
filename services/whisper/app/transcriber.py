from pathlib import Path

from app.model_catalog import get_model_option


class AudioUnreadableError(Exception):
    pass


class LocalTranscriber:
    def __init__(self, model_cache_dir="models", cpu_threads=0):
        self.model_cache_dir = model_cache_dir
        self.cpu_threads = cpu_threads
        self._models = {}

    def transcribe(self, audio_path, model_id, language):
        option = get_model_option(model_id)
        if option is None:
            raise ValueError(f"Unknown model: {model_id}")
        if not Path(audio_path).is_file():
            raise AudioUnreadableError(f"Audio file does not exist: {audio_path}")

        model = self._load_model(model_id, option["compute_type"])
        segments, info = model.transcribe(
            audio_path,
            language=language,
            vad_filter=True,
            beam_size=5,
        )
        segment_list = [
            {"start": segment.start, "end": segment.end, "text": segment.text.strip()}
            for segment in segments
        ]
        text = " ".join(segment["text"] for segment in segment_list).strip()
        return {
            "text": text,
            "language": info.language,
            "durationSeconds": info.duration,
            "segments": segment_list,
        }

    def _load_model(self, model_id, compute_type):
        from faster_whisper import WhisperModel

        if model_id not in self._models:
            self._models[model_id] = WhisperModel(
                model_id,
                device="cpu",
                compute_type=compute_type,
                download_root=self.model_cache_dir,
                local_files_only=True,
                cpu_threads=self.cpu_threads,
            )
        return self._models[model_id]
